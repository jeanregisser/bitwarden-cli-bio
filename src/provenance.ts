import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logVerbose } from "./log";

/**
 * Unlock-request provenance: surface WHICH process is asking for a biometric
 * unlock, so an unexpected Touch ID / Windows Hello prompt can be correlated
 * (and denied) instead of reflexively approved.
 *
 * Biometrics prove the user is present — not which process asked. Any process
 * running as the user can trigger a legitimate-looking prompt; these opt-in
 * hooks close that gap:
 *
 * - BWBIO_AUDIT_LOG=<path>  append a timestamped entry (args, cwd, parent
 *   command, process ancestry) for every biometric unlock attempt
 * - BWBIO_NOTIFY=true       show an OS notification naming the requester
 *   alongside the biometric prompt (macOS only for now)
 *
 * Everything here is best-effort: provenance reporting must never block,
 * break, or slow down an unlock.
 */

/** Max parent-chain hops to walk when naming the requester. */
const MAX_CHAIN_DEPTH = 6;

/** One hop in the requester's process ancestry. */
export interface ProcessInfo {
  pid: number;
  command: string;
}

/**
 * Read the parent PID and command name of a process via `ps`.
 * Returns null on Windows or when `ps` fails (never throws).
 */
function getParentInfo(pid: number): { ppid: number; command: string } | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const ppidRaw = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    const ppid = Number.parseInt(ppidRaw, 10);
    if (!Number.isFinite(ppid) || ppid <= 1) {
      return null;
    }
    const command = execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return { ppid, command };
  } catch {
    return null;
  }
}

/**
 * Walk the parent-process chain of this bwbio invocation, closest first.
 * Best-effort: returns however many hops could be resolved (empty on Windows).
 */
export function getRequesterChain(): ProcessInfo[] {
  const chain: ProcessInfo[] = [];
  let pid = process.pid;
  for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
    const parent = getParentInfo(pid);
    if (!parent) {
      break;
    }
    // Keep the basename only — full paths are noisy in a notification
    const name = parent.command.split("/").pop() || parent.command;
    chain.push({ pid: parent.ppid, command: name });
    pid = parent.ppid;
  }
  return chain;
}

/**
 * Read the immediate parent's full command line (truncated), for the audit
 * log and notification body. Returns null when unavailable.
 */
export function getParentCommandLine(): string | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const ppid = execFileSync(
      "ps",
      ["-o", "ppid=", "-p", String(process.pid)],
      {
        encoding: "utf8",
        timeout: 1000,
      },
    ).trim();
    const command = execFileSync("ps", ["-o", "command=", "-p", ppid], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return command ? command.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** Render a requester chain as a compact one-line string, closest parent first. */
export function formatChain(chain: ProcessInfo[]): string {
  if (chain.length === 0) {
    return "unknown";
  }
  return chain.map((p) => `${p.command}(${p.pid})`).join(" <- ");
}

/** Build the multi-line audit-log entry for one unlock attempt. */
export function formatAuditEntry(
  args: string[],
  cwd: string,
  chain: ProcessInfo[],
  parentCommandLine: string | null,
  timestamp: Date,
): string {
  const lines = [
    `[${timestamp.toISOString()}] bwbio ${args.join(" ")} | cwd=${cwd}`,
    `  requester: ${formatChain(chain)}`,
    `  parent-cmd: ${parentCommandLine ?? "unknown"}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Strip characters that could escape the AppleScript string literal.
 * Notification content is display-only, so lossy sanitization is fine.
 */
export function sanitizeForNotification(text: string): string {
  return text.replace(/["\\]/g, " ").slice(0, 180);
}

/** Append an entry to BWBIO_AUDIT_LOG, creating parent directories as needed. */
function writeAuditLog(args: string[], chain: ProcessInfo[]): void {
  const auditPath = process.env.BWBIO_AUDIT_LOG;
  if (!auditPath) {
    return;
  }
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(
      auditPath,
      formatAuditEntry(
        args,
        process.cwd(),
        chain,
        getParentCommandLine(),
        new Date(),
      ),
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logVerbose(`Failed to write audit log: ${error}`);
  }
}

/**
 * Fire an OS notification naming the requester (macOS only for now).
 * Fire-and-forget: the child is unref'd and errors are ignored so a broken
 * notifier can never delay or fail the unlock.
 */
function notifyRequester(chain: ProcessInfo[]): void {
  if (process.env.BWBIO_NOTIFY !== "true") {
    return;
  }
  if (process.platform !== "darwin") {
    logVerbose("BWBIO_NOTIFY is only supported on macOS for now");
    return;
  }
  const requester = getParentCommandLine() ?? formatChain(chain);
  const body = sanitizeForNotification(`${requester} | ${process.cwd()}`);
  const script = `display notification "${body}" with title "Bitwarden unlock request" subtitle "deny the biometric prompt if unexpected"`;
  try {
    const child = execFile("osascript", ["-e", script], () => {});
    child.unref();
  } catch {
    // never let notification failures affect the unlock path
  }
}

/**
 * Report an imminent biometric unlock attempt: audit log + OS notification.
 * No-op unless the corresponding env vars are set; never throws.
 */
export function reportUnlockRequest(args: string[]): void {
  if (!process.env.BWBIO_AUDIT_LOG && process.env.BWBIO_NOTIFY !== "true") {
    return;
  }
  try {
    const chain = getRequesterChain();
    writeAuditLog(args, chain);
    notifyRequester(chain);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logVerbose(`Provenance reporting failed: ${error}`);
  }
}
