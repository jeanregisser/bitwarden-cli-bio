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

// Uses real Unix domain sockets: the race covered here depends on Node's
// event ordering, which a mocked socket would not reproduce.
describe.skipIf(os.platform() === "win32")("IpcSocketService", () => {
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
