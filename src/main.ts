import { spawn } from "node:child_process";
import { attemptBiometricUnlock } from "./biometrics";
import { isPassthroughCommand } from "./passthrough";
import { generateSessionKey, storeUserKeyForSession } from "./session-storage";

function writeLn(s: string): void {
  if (process.env.BW_QUIET !== "true") {
    process.stdout.write(`${s}\n`);
  }
}

/**
 * Get the path to the official bw CLI.
 *
 * Shell aliases don't apply when spawning via child_process,
 * so aliasing bwbio as bw won't cause a conflict here.
 */
function getBwPath(): string {
  return "bw";
}

/**
 * Execute the official bw CLI with the given arguments.
 *
 * @param args - Command line arguments to pass to bw
 * @param sessionKey - Optional BW_SESSION value to set
 * @returns Exit code from bw
 */
async function executeBw(args: string[], sessionKey?: string): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env };

    if (sessionKey) {
      env.BW_SESSION = sessionKey;
    }

    const child = spawn(getBwPath(), args, {
      stdio: "inherit",
      env,
      // On Windows, spawn needs shell to resolve .cmd wrappers (e.g. bw.cmd)
      shell: process.platform === "win32",
    });

    child.on("error", (err) => {
      console.error(`Failed to execute bw: ${err.message}`);
      resolve(1);
    });

    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  });
}

/**
 * Handle the 'unlock' command specially to output BW_SESSION export.
 */
async function handleUnlock(
  args: string[],
  sessionKey: string,
): Promise<number> {
  // Check if --raw flag is present
  const isRaw = args.includes("--raw");

  if (isRaw) {
    writeLn(sessionKey);
  } else {
    writeLn(`export BW_SESSION="${sessionKey}"`);
    writeLn(`# Run this command to set the session: eval $(bwbio unlock)`);
  }

  return 0;
}

/**
 * Main entry point for the CLI wrapper.
 *
 * Attempts biometric unlock via the Desktop app, then delegates to bw.
 * Skips biometrics when BW_SESSION is set, in non-interactive mode, or for passthrough commands.
 */
export async function main(args: string[]): Promise<number> {
  // Mirror --quiet and --nointeraction flags to env vars (same as bw CLI)
  if (args.includes("--quiet")) {
    process.env.BW_QUIET = "true";
  }
  if (args.includes("--nointeraction")) {
    process.env.BW_NOINTERACTION = "true";
  }

  // Skip biometric unlock when not needed or not possible
  if (
    process.env.BW_SESSION ||
    process.env.BW_NOINTERACTION === "true" ||
    isPassthroughCommand(args)
  ) {
    return executeBw(args);
  }

  // Attempt biometric unlock
  const result = await attemptBiometricUnlock();

  if (result.success) {
    // Generate a new session key and store the user key
    const sessionKey = generateSessionKey();
    storeUserKeyForSession(result.userKeyB64, result.userId, sessionKey);

    // Check if this is an explicit 'unlock' command
    if (args[0] === "unlock") {
      return handleUnlock(args, sessionKey);
    }

    // Execute the requested command with the session
    return executeBw(args, sessionKey);
  }

  // Biometric unlock failed or unavailable - fall back to regular bw CLI
  return executeBw(args);
}
