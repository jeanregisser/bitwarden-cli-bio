import * as net from "net";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as crypto from "crypto";
import * as forge from "node-forge";

/**
 * Mock Desktop IPC server for testing.
 *
 * Simulates the Bitwarden Desktop app's IPC protocol.
 */
export class MockDesktopServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private connections: net.Socket[] = [];

  // Configurable responses
  private _biometricsEnabled = true;
  private _userId = "test-user-id";
  private _userKey = "test-session-key-base64";

  // Message tracking
  private _receivedMessages: Array<{ command: string; payload?: unknown }> = [];

  // Encryption state per connection
  private connectionStates = new Map<
    net.Socket,
    { sharedKey: Buffer; messageId: number }
  >();

  constructor() {
    this.socketPath = this.getSocketPath();
  }

  private getSocketPath(): string {
    const platform = process.platform;

    switch (platform) {
      case "darwin": {
        // Use a test-specific path to avoid conflicting with real Desktop app
        const testDir = path.join(os.tmpdir(), "bwbio-test");
        fs.mkdirSync(testDir, { recursive: true });
        return path.join(testDir, "app.sock");
      }
      case "win32": {
        return "\\\\.\\pipe\\bitwarden-test";
      }
      case "linux": {
        const testDir = path.join(os.tmpdir(), "bwbio-test");
        fs.mkdirSync(testDir, { recursive: true });
        return path.join(testDir, "bitwarden.sock");
      }
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  /**
   * Start the mock server.
   */
  async start(): Promise<void> {
    // Clean up any existing socket
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore if doesn't exist
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", reject);

      this.server.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the mock server.
   */
  async stop(): Promise<void> {
    // Close all connections
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections = [];
    this.connectionStates.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            fs.unlinkSync(this.socketPath);
          } catch {
            // Ignore
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Configure biometrics enabled status.
   */
  setBiometricsEnabled(enabled: boolean): void {
    this._biometricsEnabled = enabled;
  }

  /**
   * Configure the user ID to return.
   */
  setUserId(userId: string): void {
    this._userId = userId;
  }

  /**
   * Configure the user key to return on unlock.
   */
  setUserKey(key: string): void {
    this._userKey = key;
  }

  /**
   * Get all received messages for inspection.
   */
  get receivedMessages(): Array<{ command: string; payload?: unknown }> {
    return [...this._receivedMessages];
  }

  /**
   * Clear received messages.
   */
  clearReceivedMessages(): void {
    this._receivedMessages = [];
  }

  /**
   * Get the socket path for clients to connect to.
   */
  getSocketPathForClient(): string {
    return this.socketPath;
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.push(socket);

    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Try to parse complete messages
      while (buffer.length >= 4) {
        const messageLength = buffer.readUInt32LE(0);
        if (buffer.length < 4 + messageLength) {
          break; // Wait for more data
        }

        const messageJson = buffer.subarray(4, 4 + messageLength).toString("utf8");
        buffer = buffer.subarray(4 + messageLength);

        try {
          const message = JSON.parse(messageJson);
          this.handleMessage(socket, message);
        } catch (err) {
          console.error("Mock server: failed to parse message", err);
        }
      }
    });

    socket.on("close", () => {
      this.connections = this.connections.filter((c) => c !== socket);
      this.connectionStates.delete(socket);
    });

    socket.on("error", () => {
      // Ignore errors on connection
    });
  }

  private handleMessage(socket: net.Socket, message: {
    command: string;
    appId: string;
    messageId: number;
    payload?: unknown;
  }): void {
    this._receivedMessages.push({
      command: message.command,
      payload: message.payload,
    });

    switch (message.command) {
      case "bw-handshake":
        this.handleHandshake(socket, message);
        break;
      case "encrypted":
        this.handleEncrypted(socket, message);
        break;
      default:
        console.error(`Mock server: unknown command ${message.command}`);
    }
  }

  private handleHandshake(socket: net.Socket, message: {
    command: string;
    appId: string;
    messageId: number;
    payload?: { publicKey?: string };
  }): void {
    // Generate a shared key
    const sharedKey = crypto.randomBytes(32);

    // Encrypt shared key with client's public key
    const publicKeyPem = Buffer.from(
      message.payload?.publicKey || "",
      "base64"
    ).toString("utf8");
    const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);

    const encryptedSharedKey = publicKey.encrypt(
      sharedKey.toString("binary"),
      "RSA-OAEP",
      {
        md: forge.md.sha256.create(),
      }
    );

    // Store connection state
    this.connectionStates.set(socket, {
      sharedKey,
      messageId: message.messageId,
    });

    // Send response
    const response = {
      command: "bw-handshake",
      messageId: message.messageId,
      appId: message.appId,
      payload: {
        status: "success",
        sharedKey: Buffer.from(encryptedSharedKey, "binary").toString("base64"),
      },
    };

    this.sendMessage(socket, response);
  }

  private handleEncrypted(socket: net.Socket, message: {
    command: string;
    appId: string;
    messageId: number;
    payload?: { iv: string; data: string; mac: string };
  }): void {
    const state = this.connectionStates.get(socket);
    if (!state || !message.payload) {
      return;
    }

    // Decrypt the message
    const iv = Buffer.from(message.payload.iv, "base64");
    const data = Buffer.from(message.payload.data, "base64");

    const decipher = crypto.createDecipheriv("aes-256-cbc", state.sharedKey, iv);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    const innerMessage = JSON.parse(decrypted.toString("utf8")) as {
      command: string;
      userId?: string;
    };

    this._receivedMessages.push({
      command: innerMessage.command,
      payload: innerMessage,
    });

    // Handle inner command
    let responsePayload: object;

    switch (innerMessage.command) {
      case "bw-status":
        responsePayload = {
          status: "success",
          biometricsEnabled: this._biometricsEnabled,
          userId: this._userId,
        };
        break;
      case "bw-credential-retrieval":
        if (this._biometricsEnabled) {
          responsePayload = {
            status: "success",
            userKeyB64: this._userKey,
          };
        } else {
          responsePayload = {
            status: "error",
            error: "Biometrics not enabled",
          };
        }
        break;
      default:
        responsePayload = {
          status: "error",
          error: `Unknown command: ${innerMessage.command}`,
        };
    }

    // Encrypt response
    const responseJson = JSON.stringify(responsePayload);
    const responseIv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      state.sharedKey,
      responseIv
    );
    const encrypted = Buffer.concat([
      cipher.update(responseJson, "utf8"),
      cipher.final(),
    ]);

    // Create HMAC
    const hmac = crypto.createHmac("sha256", state.sharedKey);
    hmac.update(responseIv);
    hmac.update(encrypted);
    const mac = hmac.digest();

    const response = {
      command: "encrypted",
      messageId: message.messageId,
      appId: message.appId,
      payload: {
        iv: responseIv.toString("base64"),
        data: encrypted.toString("base64"),
        mac: mac.toString("base64"),
      },
    };

    this.sendMessage(socket, response);
  }

  private sendMessage(socket: net.Socket, message: object): void {
    const json = JSON.stringify(message);
    const messageBuffer = Buffer.from(json, "utf8");
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(messageBuffer.length, 0);

    socket.write(Buffer.concat([lengthBuffer, messageBuffer]));
  }
}
