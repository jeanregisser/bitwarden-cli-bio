import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import * as path from "path";
import { MockDesktopServer } from "./mock-desktop-server";
import { extractUserKey, getActiveUserId } from "./extract-user-key";

const BW_TEST_EMAIL = process.env.BW_TEST_EMAIL;
const BW_TEST_PASSWORD = process.env.BW_TEST_PASSWORD;

if (!BW_TEST_EMAIL || !BW_TEST_PASSWORD) {
  throw new Error(
    "E2E tests require BW_TEST_EMAIL and BW_TEST_PASSWORD environment variables"
  );
}

const bwbioPath = path.resolve(__dirname, "../../dist/index.js");

function exec(
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ stdout: string; output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });

    const stdoutChunks: Buffer[] = [];
    const outputChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      outputChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const output = Buffer.concat(outputChunks).toString("utf-8").trim();
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        console.error(`[${command} ${args.join(" ")}] exit ${exitCode}:\n${output}`);
      }
      resolve({ stdout, output, exitCode });
    });
  });
}

function bw(args: string[], env?: Record<string, string>) {
  return exec("bw", args, env);
}

function bwbio(args: string[], env?: Record<string, string>) {
  return exec("node", [bwbioPath, ...args], {
    BWBIO_IPC_SOCKET_PATH: mockSocketPath,
    ...env,
  });
}

let mockSocketPath: string;

describe("bwbio E2E", () => {
  let mockServer: MockDesktopServer;
  let userId: string;
  let userKey: string;

  beforeAll(async () => {
    // 1. Login (or verify already logged in)
    const statusResult = await bw(["status"]);
    if (statusResult.exitCode !== 0) {
      throw new Error(`bw status failed (exit ${statusResult.exitCode})`);
    }
    const status = JSON.parse(statusResult.stdout);

    if (status.status === "unauthenticated") {
      const loginResult = await exec("bw", [
        "login",
        BW_TEST_EMAIL!,
        BW_TEST_PASSWORD!,
        "--raw",
      ]);
      if (loginResult.exitCode !== 0) {
        throw new Error(`bw login failed (exit ${loginResult.exitCode})`);
      }
    }

    // 2. Sync vault
    await bw(["sync"]);

    // 3. Unlock to get BW_SESSION
    const unlockResult = await bw(["unlock", BW_TEST_PASSWORD!, "--raw"]);
    if (unlockResult.exitCode !== 0) {
      throw new Error(`bw unlock failed (exit ${unlockResult.exitCode})`);
    }
    const session = unlockResult.stdout;

    // 4. Get userId
    const uid = getActiveUserId();
    if (!uid) throw new Error("Could not read active user ID from data.json");
    userId = uid;

    // 5. Extract real user key
    userKey = extractUserKey(userId, session);

    // 6. Lock the vault so bwbio needs to unlock via biometrics
    await bw(["lock"]);

    // 7. Start mock IPC server with real user key
    mockServer = new MockDesktopServer();
    mockSocketPath = mockServer.getSocketPath();
    mockServer.setUserKey(userKey);
    mockServer.setUserId(userId);
    await mockServer.start();
  }, 60_000);

  afterAll(async () => {
    if (mockServer) await mockServer.stop();
    // Lock vault for cleanup
    await bw(["lock"]);
  });

  test("unlock via biometrics unlocks the vault", async () => {
    const result = await bwbio(["unlock", "--raw"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^[A-Za-z0-9+/=]+$/);

    // Verify the session key actually works
    const statusResult = await bw(["status"], { BW_SESSION: result.stdout });
    const status = JSON.parse(statusResult.stdout);
    expect(status.status).toBe("unlocked");
  });

  test("list items returns data", async () => {
    const result = await bwbio(["list", "items"]);
    expect(result.exitCode).toBe(0);
    const items = JSON.parse(result.stdout);
    expect(items).toBeInstanceOf(Array);
  });

  test("get item by id works", async () => {
    const listResult = await bwbio(["list", "items"]);
    const items = JSON.parse(listResult.stdout);
    expect(items.length).toBeGreaterThan(0);
    const result = await bwbio(["get", "item", items[0].id]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty("id");
  });

  test("status command skips biometric unlock", async () => {
    mockServer.clearReceivedMessages();
    const result = await bwbio(["status"]);
    expect(result.exitCode).toBe(0);
    // status is a passthrough command — no IPC messages should be sent
    const ipcMessages = mockServer.receivedMessages.filter(
      (m) => m.command !== "setupEncryption"
    );
    expect(ipcMessages).toHaveLength(0);
  });

  test("falls back when mock server stopped", async () => {
    await mockServer.stop();
    // status is passthrough, should work without the server
    const result = await bwbio(["status"]);
    expect(result.exitCode).toBe(0);

    // Restart for any subsequent tests
    mockServer = new MockDesktopServer(mockSocketPath);
    mockServer.setUserKey(userKey);
    mockServer.setUserId(userId);
    await mockServer.start();
  });
});
