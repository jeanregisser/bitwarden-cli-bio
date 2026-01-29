import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Mock Desktop IPC server for E2E testing.
 *
 * Implements the real Bitwarden Desktop app IPC protocol:
 * - Length-delimited JSON messages over Unix socket
 * - RSA-OAEP (SHA-1) key exchange via setupEncryption
 * - AES-256-CBC + HMAC-SHA256 encrypted communication (64-byte shared secret)
 * - Handles getBiometricsStatusForUser and unlockWithBiometricsForUser
 */
export class MockDesktopServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private connections: net.Socket[] = [];

  // Configurable responses
  private _biometricsStatus = 0; // BiometricsStatus.Available
  private _userKey = "test-user-key-base64";

  // Message tracking
  private _receivedMessages: Array<{ command: string; payload?: unknown }> = [];

  // Encryption state per connection
  private connectionStates = new Map<net.Socket, { sharedSecret: Buffer }>();

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? this.getDefaultSocketPath();
  }

  private getDefaultSocketPath(): string {
    if (process.platform === "win32") {
      // Windows requires named pipes, not Unix domain sockets
      return "\\\\.\\pipe\\bwbio-e2e-test";
    }
    const dir = path.join(os.tmpdir(), "bwbio-e2e-test");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "s.bw");
  }

  async start(): Promise<void> {
    // Clean up any existing socket file
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
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
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  setBiometricsStatus(status: number): void {
    this._biometricsStatus = status;
  }

  setUserKey(key: string): void {
    this._userKey = key;
  }

  get receivedMessages(): Array<{ command: string; payload?: unknown }> {
    return [...this._receivedMessages];
  }

  clearReceivedMessages(): void {
    this._receivedMessages = [];
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.push(socket);
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const messageLength = buffer.readUInt32LE(0);
        if (buffer.length < 4 + messageLength) break;

        const messageJson = buffer
          .subarray(4, 4 + messageLength)
          .toString("utf8");
        buffer = buffer.subarray(4 + messageLength);

        try {
          const outer = JSON.parse(messageJson);
          this.handleOuterMessage(socket, outer);
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
      // Ignore
    });
  }

  /**
   * Handle the outer message format: { appId, message }
   * The `message` field contains either a setupEncryption command or an encrypted message.
   */
  private handleOuterMessage(
    socket: net.Socket,
    outer: { appId: string; message: Record<string, unknown> },
  ): void {
    const msg = outer.message;
    const appId = outer.appId;

    if (!msg || typeof msg !== "object") return;

    const command = msg.command as string;

    this._receivedMessages.push({ command, payload: msg });

    if (command === "setupEncryption") {
      this.handleSetupEncryption(socket, appId, msg);
    } else if ("encryptionType" in msg) {
      this.handleEncryptedMessage(socket, appId, msg);
    }
  }

  private handleSetupEncryption(
    socket: net.Socket,
    appId: string,
    msg: Record<string, unknown>,
  ): void {
    const publicKeyB64 = msg.publicKey as string;
    if (!publicKeyB64) return;

    // Import client's public key (SPKI/DER format, base64 encoded)
    const publicKeyDer = Buffer.from(publicKeyB64, "base64");
    const publicKey = crypto.createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    });

    // Generate 64-byte shared secret (32 AES + 32 HMAC)
    const sharedSecret = crypto.randomBytes(64);

    // Encrypt shared secret with client's public key (RSA-OAEP, SHA-1)
    const encryptedSecret = crypto.publicEncrypt(
      {
        key: publicKey,
        oaepHash: "sha1",
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      sharedSecret,
    );

    this.connectionStates.set(socket, { sharedSecret });

    // Send setupEncryption response
    const response = {
      command: "setupEncryption",
      appId,
      sharedSecret: encryptedSecret.toString("base64"),
    };

    this.sendMessage(socket, response);
  }

  private handleEncryptedMessage(
    socket: net.Socket,
    appId: string,
    msg: Record<string, unknown>,
  ): void {
    const state = this.connectionStates.get(socket);
    if (!state) return;

    const iv = Buffer.from(msg.iv as string, "base64");
    const data = Buffer.from(msg.data as string, "base64");
    const mac = Buffer.from(msg.mac as string, "base64");

    const encKey = state.sharedSecret.subarray(0, 32);
    const macKey = state.sharedSecret.subarray(32, 64);

    // Verify HMAC
    const hmac = crypto.createHmac("sha256", macKey);
    hmac.update(iv);
    hmac.update(data);
    const expectedMac = hmac.digest();
    if (!crypto.timingSafeEqual(mac, expectedMac)) {
      console.error("Mock server: HMAC verification failed");
      return;
    }

    // Decrypt
    const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    const inner = JSON.parse(decrypted.toString("utf8")) as {
      command: string;
      userId?: string;
      messageId?: number;
      timestamp?: number;
    };

    this._receivedMessages.push({ command: inner.command, payload: inner });

    // Build response
    let responsePayload: Record<string, unknown>;

    switch (inner.command) {
      case "getBiometricsStatusForUser":
        responsePayload = {
          command: "getBiometricsStatusForUser",
          messageId: inner.messageId,
          response: this._biometricsStatus,
          timestamp: Date.now(),
        };
        break;
      case "unlockWithBiometricsForUser":
        if (this._biometricsStatus === 0) {
          responsePayload = {
            command: "unlockWithBiometricsForUser",
            messageId: inner.messageId,
            response: true,
            userKeyB64: this._userKey,
            timestamp: Date.now(),
          };
        } else {
          responsePayload = {
            command: "unlockWithBiometricsForUser",
            messageId: inner.messageId,
            response: false,
            timestamp: Date.now(),
          };
        }
        break;
      case "getBiometricsStatus":
        responsePayload = {
          command: "getBiometricsStatus",
          messageId: inner.messageId,
          response: this._biometricsStatus,
          timestamp: Date.now(),
        };
        break;
      default:
        responsePayload = {
          command: inner.command,
          messageId: inner.messageId,
          response: null,
          timestamp: Date.now(),
        };
    }

    // Encrypt response
    const responseJson = JSON.stringify(responsePayload);
    const responseIv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", encKey, responseIv);
    const encrypted = Buffer.concat([
      cipher.update(responseJson, "utf8"),
      cipher.final(),
    ]);

    const responseMac = crypto.createHmac("sha256", macKey);
    responseMac.update(responseIv);
    responseMac.update(encrypted);
    const responseTag = responseMac.digest();

    const outerResponse = {
      appId,
      message: {
        encryptionType: 2,
        encryptedString: `2.${responseIv.toString("base64")}|${encrypted.toString("base64")}|${responseTag.toString("base64")}`,
        iv: responseIv.toString("base64"),
        data: encrypted.toString("base64"),
        mac: responseTag.toString("base64"),
      },
    };

    this.sendMessage(socket, outerResponse);
  }

  private sendMessage(socket: net.Socket, message: object): void {
    const json = JSON.stringify(message);
    const messageBuffer = Buffer.from(json, "utf8");
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(messageBuffer.length, 0);
    socket.write(Buffer.concat([lengthBuffer, messageBuffer]));
  }
}
