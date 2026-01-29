import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const DEBUG = process.env.BWBIO_DEBUG === "1";

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
   * Get the IPC socket path for the current platform.
   * This mirrors the logic in desktop_native/core/src/ipc/mod.rs
   */
  getSocketPath(): string {
    const platform = os.platform();

    if (platform === "win32") {
      return this.getWindowsSocketPath();
    }

    if (platform === "darwin") {
      return this.getMacSocketPath();
    }

    // Linux: use XDG cache directory or fallback
    return this.getLinuxSocketPath();
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
   * We check both paths and return the one that exists.
   */
  private getMacSocketPath(): string {
    const homeDir = os.homedir();

    // Path for sandboxed Desktop app (Mac App Store version)
    const sandboxedPath = path.join(
      homeDir,
      "Library",
      "Group Containers",
      "LTZ2PFU5D6.com.bitwarden.desktop",
      "s.bw"
    );

    // Path for non-sandboxed Desktop app
    const nonSandboxedPath = path.join(
      homeDir,
      "Library",
      "Caches",
      "com.bitwarden.desktop",
      "s.bw"
    );

    // Check sandboxed path first (most common for Mac App Store users)
    try {
      fs.accessSync(sandboxedPath);
      return sandboxedPath;
    } catch {
      // Socket not found at sandboxed path
    }

    // Check non-sandboxed path
    try {
      fs.accessSync(nonSandboxedPath);
      return nonSandboxedPath;
    } catch {
      // Socket not found at non-sandboxed path either
    }

    // Default to sandboxed path
    return sandboxedPath;
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
   * Check if the desktop app socket exists (quick availability check).
   */
  async isSocketAvailable(): Promise<boolean> {
    const socketPath = this.getSocketPath();
    try {
      await fs.promises.access(socketPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Connect to the desktop app's IPC socket.
   */
  async connect(): Promise<void> {
    if (this.socket != null) {
      return;
    }

    const socketPath = this.getSocketPath();

    if (DEBUG) {
      console.error(`[DEBUG] Connecting to socket: ${socketPath}`);
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);

      socket.on("connect", () => {
        if (DEBUG) {
          console.error(`[DEBUG] Socket connected`);
        }
        this.socket = socket;
        resolve();
      });

      socket.on("data", (data: Buffer) => {
        if (DEBUG) {
          console.error(`[DEBUG] Received raw data: ${data.length} bytes`);
        }
        this.processIncomingData(data);
      });

      socket.on("error", (err) => {
        if (this.socket == null) {
          reject(new Error(`Failed to connect to desktop app: ${err.message}`));
        }
      });

      socket.on("close", () => {
        this.socket = null;
        this.messageBuffer = Buffer.alloc(0);
        if (this.disconnectHandler) {
          this.disconnectHandler();
        }
      });

      // Timeout for initial connection
      socket.setTimeout(5000, () => {
        if (this.socket == null) {
          socket.destroy();
          reject(new Error("Connection to desktop app timed out"));
        }
      });
    });
  }

  /**
   * Disconnect from the socket.
   */
  disconnect(): void {
    if (this.socket != null) {
      this.socket.destroy();
      this.socket = null;
    }
    this.messageBuffer = Buffer.alloc(0);
  }

  /**
   * Check if currently connected.
   */
  isConnected(): boolean {
    return this.socket != null && !this.socket.destroyed;
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

    if (DEBUG) {
      console.error(`[DEBUG] Sending ${buffer.length} bytes (message: ${messageBytes.length} bytes)`);
    }

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
        }
      } catch {
        // Failed to parse message
      }
    }
  }
}
