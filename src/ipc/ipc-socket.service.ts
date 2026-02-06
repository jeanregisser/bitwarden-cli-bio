import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logDebug, logVerbose } from "../log";

/**
 * Platform-specific IPC socket service for connecting to the Bitwarden desktop app.
 *
 * The desktop app listens on a Unix domain socket (macOS/Linux) or named pipe (Windows).
 * This service provides a platform-agnostic way to connect and communicate with it.
 */
export class IpcSocketService {
  private socket: net.Socket | null = null;
  private messageBuffer: Buffer = Buffer.alloc(0);
  private messageHandler: ((message: unknown) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;

  /**
   * Get all socket candidates for the current platform in lookup order.
   */
  getSocketCandidates(): string[] {
    if (process.env.BWBIO_IPC_SOCKET_PATH) {
      return [process.env.BWBIO_IPC_SOCKET_PATH];
    }

    const platform = os.platform();

    if (platform === "win32") {
      return [this.getWindowsSocketPath()];
    }

    if (platform === "darwin") {
      return this.getMacSocketPaths();
    }

    // Linux: use XDG cache directory or fallback
    return [this.getLinuxSocketPath()];
  }

  /**
   * Windows named pipe path - uses hash of home directory.
   */
  private getWindowsSocketPath(): string {
    const homeDir = os.homedir();
    const hash = crypto.createHash("sha256").update(homeDir).digest();
    // Use URL-safe base64 without padding (like Rust's URL_SAFE_NO_PAD)
    const hashB64 = hash
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `\\\\.\\pipe\\${hashB64}.s.bw`;
  }

  /**
   * Get the socket path on macOS.
   * The Desktop app can be sandboxed (Mac App Store) or non-sandboxed.
   */
  private getMacSocketPaths(): string[] {
    const homeDir = os.homedir();

    // Path for sandboxed Desktop app (Mac App Store version)
    const sandboxedPath = path.join(
      homeDir,
      "Library",
      "Group Containers",
      "LTZ2PFU5D6.com.bitwarden.desktop",
      "s.bw",
    );

    // Path for non-sandboxed Desktop app
    const nonSandboxedPath = path.join(
      homeDir,
      "Library",
      "Caches",
      "com.bitwarden.desktop",
      "s.bw",
    );

    return [sandboxedPath, nonSandboxedPath];
  }

  /**
   * Linux socket path - uses XDG_CACHE_HOME or ~/.cache.
   */
  private getLinuxSocketPath(): string {
    const cacheDir =
      process.env.XDG_CACHE_HOME != null
        ? process.env.XDG_CACHE_HOME
        : path.join(os.homedir(), ".cache");
    return path.join(cacheDir, "com.bitwarden.desktop", "s.bw");
  }

  /**
   * Connect to the desktop app's IPC socket.
   */
  async connect(): Promise<void> {
    if (this.socket != null) {
      logDebug("connect() called while already connected");
      return;
    }

    const socketPaths = this.getSocketCandidates();
    for (const socketPath of socketPaths) {
      logVerbose(`Connecting to desktop app (via ${socketPath})`);
      try {
        await this.connectToSocketPath(socketPath);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logVerbose(`Failed to connect: ${message}`);
      }
    }

    throw new Error("Failed to connect to desktop app (is the app running?)");
  }

  /**
   * Connect to a specific desktop app IPC socket path.
   */
  private async connectToSocketPath(socketPath: string): Promise<void> {
    logDebug(`Connecting to socket: ${socketPath}`);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);

      socket.on("connect", () => {
        logDebug(`Socket connected: ${socketPath}`);
        this.socket = socket;
        resolve();
      });

      socket.on("data", (data: Buffer) => {
        logDebug(`Received raw data: ${data.length} bytes`);
        this.processIncomingData(data);
      });

      socket.on("error", (err) => {
        logDebug(
          `Socket error on ${socketPath}: ${err.message} (connected=${this.socket != null})`,
        );
        if (this.socket == null) {
          reject(err);
        }
      });

      socket.on("close", (hadError) => {
        logDebug(`Socket closed: ${socketPath} (hadError=${hadError})`);
        this.socket = null;
        this.messageBuffer = Buffer.alloc(0);
        if (this.disconnectHandler) {
          this.disconnectHandler();
        }
      });

      // Timeout for initial connection
      socket.setTimeout(5000, () => {
        if (this.socket == null) {
          logDebug(`Connection timeout for socket: ${socketPath}`);
          socket.destroy();
          reject(new Error("Connection to desktop app timed out"));
        } else {
          logDebug(`Socket timeout ignored (already connected): ${socketPath}`);
        }
      });
    });
  }

  /**
   * Disconnect from the socket.
   */
  disconnect(): void {
    if (this.socket != null) {
      logDebug("Disconnecting socket");
      this.socket.destroy();
      this.socket = null;
    }
    this.messageBuffer = Buffer.alloc(0);
  }

  /**
   * Set the handler for incoming messages.
   */
  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Set the handler for disconnect events.
   */
  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Send a message to the desktop app.
   * Uses length-delimited protocol: 4-byte little-endian length prefix + JSON payload.
   */
  sendMessage(message: unknown): void {
    if (this.socket == null || this.socket.destroyed) {
      throw new Error("Not connected to desktop app");
    }

    const messageStr = JSON.stringify(message);
    const messageBytes = Buffer.from(messageStr, "utf8");

    // Create buffer with 4-byte length prefix (little-endian)
    const buffer = Buffer.alloc(4 + messageBytes.length);
    buffer.writeUInt32LE(messageBytes.length, 0);
    messageBytes.copy(buffer, 4);

    logDebug(
      `Sending ${buffer.length} bytes (message: ${messageBytes.length} bytes)`,
    );

    this.socket.write(buffer);
  }

  /**
   * Process incoming data from the socket.
   * Messages are length-delimited: 4-byte LE length + JSON payload.
   */
  private processIncomingData(data: Buffer): void {
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);

    // Process all complete messages in the buffer
    while (this.messageBuffer.length >= 4) {
      const messageLength = this.messageBuffer.readUInt32LE(0);

      // Check if we have the full message
      if (this.messageBuffer.length < 4 + messageLength) {
        logDebug(
          `Waiting for more data: need ${4 + messageLength}, have ${this.messageBuffer.length}`,
        );
        break;
      }

      // Extract and parse the message
      const messageBytes = this.messageBuffer.subarray(4, 4 + messageLength);
      const messageStr = messageBytes.toString("utf8");

      // Update buffer to remove processed message
      this.messageBuffer = this.messageBuffer.subarray(4 + messageLength);

      try {
        const message = JSON.parse(messageStr);
        if (this.messageHandler) {
          this.messageHandler(message);
        } else {
          logDebug("Dropped message because no message handler is set");
        }
      } catch {
        logDebug("Failed to parse incoming IPC message as JSON");
      }
    }
  }
}
