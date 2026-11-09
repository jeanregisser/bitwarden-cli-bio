import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { IpcSocketService } from "./ipc-socket.service";

// Real os by default; tests override it to check other platforms' paths
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    platform: vi.fn(actual.platform),
    homedir: vi.fn(actual.homedir),
  };
});

describe("IpcSocketService.getSocketCandidates", () => {
  const home = path.join("/home", "alice");

  beforeEach(() => {
    vi.mocked(os.platform).mockReturnValue("linux");
    vi.mocked(os.homedir).mockReturnValue(home);
    vi.stubEnv("BWBIO_IPC_SOCKET_PATH", "");
  });

  afterEach(() => {
    vi.mocked(os.platform).mockRestore();
    vi.mocked(os.homedir).mockRestore();
    vi.unstubAllEnvs();
  });

  it("tries the native then the Flatpak socket on Linux", () => {
    vi.stubEnv("XDG_CACHE_HOME", path.join(home, ".my-cache"));

    expect(new IpcSocketService().getSocketCandidates()).toEqual([
      path.join(home, ".my-cache", "com.bitwarden.desktop", "s.bw"),
      path.join(
        home,
        ".var",
        "app",
        "com.bitwarden.desktop",
        "cache",
        "com.bitwarden.desktop",
        "s.bw",
      ),
    ]);
  });

  it("defaults the native socket to ~/.cache on Linux", () => {
    vi.stubEnv("XDG_CACHE_HOME", undefined);

    expect(new IpcSocketService().getSocketCandidates()[0]).toBe(
      path.join(home, ".cache", "com.bitwarden.desktop", "s.bw"),
    );
  });
});

// Uses real Unix domain sockets: the race covered here depends on Node's
// event ordering, which a mocked socket would not reproduce.
describe.skipIf(os.platform() === "win32")("IpcSocketService.connect", () => {
  let tmpDir: string;
  let server: net.Server;
  let serverSockets: net.Socket[];
  let service: IpcSocketService;
  let onDisconnect: Mock<() => void>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bwbio-ipc-"));
    const livePath = path.join(tmpDir, "live.sock");
    serverSockets = [];
    server = net.createServer((socket) => serverSockets.push(socket));
    await new Promise<void>((resolve) => server.listen(livePath, resolve));

    // First candidate fails (ENOENT), like the Group Containers path on a
    // non-sandboxed macOS install
    service = new IpcSocketService();
    vi.spyOn(service, "getSocketCandidates").mockReturnValue([
      path.join(tmpDir, "missing.sock"),
      livePath,
    ]);
    onDisconnect = vi.fn();
    service.onDisconnect(onDisconnect);
  });

  afterEach(async () => {
    service.disconnect();
    for (const socket of serverSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores a late close from a failed candidate", async () => {
    await service.connect();
    // Let the failed candidate's handle-close callback run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onDisconnect).not.toHaveBeenCalled();
    expect(() => service.sendMessage({ command: "ping" })).not.toThrow();
  });

  it("reports a disconnect once when the active socket closes", async () => {
    await service.connect();
    await vi.waitFor(() => expect(serverSockets).toHaveLength(1));
    serverSockets[0].destroy();

    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(() => service.sendMessage({ command: "ping" })).toThrow(
      "Not connected to desktop app",
    );
  });
});
