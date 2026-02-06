import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import * as fingerprint from "../fingerprint";
import { NativeMessagingClient } from "./native-messaging-client";

// Mock the IPC socket boundary
vi.mock("./ipc-socket.service", () => {
  const MockIpcSocketService = vi.fn(function (this: any) {
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.disconnect = vi.fn();
    this.onMessage = vi.fn();
    this.onDisconnect = vi.fn();
    this.sendMessage = vi.fn();
  });
  return { IpcSocketService: MockIpcSocketService };
});

function getMockSocket(client: NativeMessagingClient) {
  return (client as any).ipcSocket as {
    connect: Mock;
    disconnect: Mock;
    onMessage: Mock;
    onDisconnect: Mock;
    sendMessage: Mock;
  };
}

describe("NativeMessagingClient", () => {
  let client: NativeMessagingClient;
  let mockSocket: ReturnType<typeof getMockSocket>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    client = new NativeMessagingClient("test-app-id", "mock-user-id");
    mockSocket = getMockSocket(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connection lifecycle", () => {
    it("connects and sets up handlers", async () => {
      await client.connect();

      expect(mockSocket.connect).toHaveBeenCalled();
      expect(mockSocket.onMessage).toHaveBeenCalled();
      expect(mockSocket.onDisconnect).toHaveBeenCalled();
    });

    it("only connects once", async () => {
      await client.connect();
      await client.connect();

      expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    });

    it("disconnects", () => {
      client.disconnect();
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    let messageHandler: (message: unknown) => void;

    beforeEach(async () => {
      mockSocket.onMessage.mockImplementation((handler: any) => {
        messageHandler = handler;
      });

      await client.connect();
    });

    describe("wrongUserId", () => {
      it("rejects pending operations and disconnects", async () => {
        const operation = (client as any).secureCommunication();
        await vi.advanceTimersByTimeAsync(0);

        messageHandler({ command: "wrongUserId", appId: "test-app-id" });

        await expect(operation).rejects.toThrow("Account mismatch");
        expect(mockSocket.disconnect).toHaveBeenCalled();
      });
    });

    describe("invalidateEncryption", () => {
      it("rejects pending operations and disconnects", async () => {
        const operation = (client as any).secureCommunication();
        await vi.advanceTimersByTimeAsync(0);

        messageHandler({
          command: "invalidateEncryption",
          appId: "test-app-id",
        });

        await expect(operation).rejects.toThrow("invalidated");
        expect(mockSocket.disconnect).toHaveBeenCalled();
      });

      it("ignores messages for other apps", async () => {
        const operation = (client as any).secureCommunication();
        await vi.advanceTimersByTimeAsync(0);

        // Message for different app - should be ignored
        messageHandler({
          command: "invalidateEncryption",
          appId: "other-app-id",
        });

        expect(mockSocket.disconnect).not.toHaveBeenCalled();

        // Clean up - reject the pending operation
        messageHandler({ command: "wrongUserId", appId: "test-app-id" });
        await expect(operation).rejects.toThrow();
      });
    });

    describe("verifyDesktopIPCFingerprint", () => {
      it("generates and displays fingerprint when secure channel exists", async () => {
        const spy = vi
          .spyOn(fingerprint, "getFingerprint")
          .mockReturnValue(["alpha", "bravo", "charlie", "delta", "echo"]);
        const stderrSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        // Fake public key - getFingerprint is mocked so export() just needs to return a Buffer
        const publicKey = {
          export: () => Buffer.from("fake-public-key-der"),
        };
        (client as any).secureChannel = { publicKey };

        messageHandler({ command: "verifyDesktopIPCFingerprint" });
        await vi.advanceTimersByTimeAsync(0);

        expect(spy).toHaveBeenCalledWith("test-app-id", expect.any(Buffer));
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("alpha-bravo-charlie-delta-echo"),
        );

        spy.mockRestore();
        stderrSpy.mockRestore();
      });
    });
  });

  describe("onDisconnect handler", () => {
    it("rejects all pending callbacks", async () => {
      let disconnectHandler: () => void;
      mockSocket.onDisconnect.mockImplementation((handler: any) => {
        disconnectHandler = handler;
      });

      await client.connect();

      // Add pending callbacks
      const callbacks = (client as any).callbacks as Map<number, any>;
      const errors: Error[] = [];

      for (let i = 0; i < 3; i++) {
        callbacks.set(i, {
          resolver: vi.fn(),
          rejecter: (e: Error) => errors.push(e),
          timeout: setTimeout(() => {}, 60000),
        });
      }

      disconnectHandler!();

      expect(errors).toHaveLength(3);
      expect(errors[0].message).toContain("Disconnected");
      expect(callbacks.size).toBe(0);
    });
  });
});
