import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatAuditEntry,
  formatChain,
  getRequesterChain,
  reportUnlockRequest,
  sanitizeForNotification,
} from "./provenance";

describe("formatChain", () => {
  it("renders closest parent first with pids", () => {
    const chain = [
      { pid: 123, command: "zsh" },
      { pid: 45, command: "claude" },
    ];
    expect(formatChain(chain)).toBe("zsh(123) <- claude(45)");
  });

  it("returns unknown for an empty chain", () => {
    expect(formatChain([])).toBe("unknown");
  });
});

describe("formatAuditEntry", () => {
  it("includes args, cwd, requester chain, and parent command", () => {
    const entry = formatAuditEntry(
      ["unlock", "--raw"],
      "/tmp/project",
      [{ pid: 1234, command: "bash" }],
      "bash ./load_via_bw.sh",
      new Date("2026-06-10T12:00:00Z"),
    );
    expect(entry).toBe(
      "[2026-06-10T12:00:00.000Z] bwbio unlock --raw | cwd=/tmp/project\n" +
        "  requester: bash(1234)\n" +
        "  parent-cmd: bash ./load_via_bw.sh\n",
    );
  });

  it("falls back to unknown when parent command is unavailable", () => {
    const entry = formatAuditEntry([], "/", [], null, new Date(0));
    expect(entry).toContain("parent-cmd: unknown");
  });
});

describe("sanitizeForNotification", () => {
  it("strips quotes and backslashes that could escape the script literal", () => {
    expect(sanitizeForNotification('rm -rf "$HOME" \\ evil')).not.toMatch(
      /["\\]/,
    );
  });

  it("truncates long content", () => {
    expect(sanitizeForNotification("x".repeat(500))).toHaveLength(180);
  });
});

describe("getRequesterChain", () => {
  it.skipIf(process.platform === "win32")(
    "resolves at least one ancestor on unix",
    () => {
      const chain = getRequesterChain();
      expect(chain.length).toBeGreaterThan(0);
      for (const hop of chain) {
        expect(hop.pid).toBeGreaterThan(1);
        expect(hop.command).toBeTruthy();
      }
    },
  );
});

describe("reportUnlockRequest", () => {
  let dir: string;
  const savedAudit = process.env.BWBIO_AUDIT_LOG;
  const savedNotify = process.env.BWBIO_NOTIFY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bwbio-prov-"));
    delete process.env.BWBIO_AUDIT_LOG;
    delete process.env.BWBIO_NOTIFY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedAudit === undefined) {
      delete process.env.BWBIO_AUDIT_LOG;
    } else {
      process.env.BWBIO_AUDIT_LOG = savedAudit;
    }
    if (savedNotify === undefined) {
      delete process.env.BWBIO_NOTIFY;
    } else {
      process.env.BWBIO_NOTIFY = savedNotify;
    }
  });

  it.skipIf(process.platform === "win32")(
    "appends an audit entry when BWBIO_AUDIT_LOG is set",
    () => {
      const auditPath = join(dir, "nested", "audit.log");
      process.env.BWBIO_AUDIT_LOG = auditPath;

      reportUnlockRequest(["unlock", "--raw"]);

      const content = readFileSync(auditPath, "utf8");
      expect(content).toContain("bwbio unlock --raw");
      expect(content).toContain(`cwd=${process.cwd()}`);
      expect(content).toContain("requester:");
    },
  );

  it("is a no-op when neither env var is set", () => {
    const auditPath = join(dir, "audit.log");
    reportUnlockRequest(["unlock"]);
    expect(() => readFileSync(auditPath, "utf8")).toThrow();
  });
});
