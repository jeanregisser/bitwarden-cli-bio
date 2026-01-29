import * as crypto from "node:crypto";
import { IpcSocketService } from "./ipc-socket.service";

const MESSAGE_VALID_TIMEOUT = 10 * 1000; // 10 seconds
const DEFAULT_TIMEOUT = 10 * 1000; // 10 seconds for protocol messages
const USER_INTERACTION_TIMEOUT = 60 * 1000; // 60 seconds for biometric prompts

const DEBUG = process.env.BWBIO_DEBUG === "1";

/**
 * Biometrics commands matching the desktop app's expected commands.
 */
export const BiometricsCommands = {
  AuthenticateWithBiometrics: "authenticateWithBiometrics",
  GetBiometricsStatus: "getBiometricsStatus",
  UnlockWithBiometricsForUser: "unlockWithBiometricsForUser",
  GetBiometricsStatusForUser: "getBiometricsStatusForUser",
  CanEnableBiometricUnlock: "canEnableBiometricUnlock",
} as const;

/**
 * Biometrics status enum matching the desktop app's BiometricsStatus.
 */
export enum BiometricsStatus {
  Available = 0,
  UnlockNeeded = 1,
  HardwareUnavailable = 2,
  AutoSetupNeeded = 3,
  ManualSetupNeeded = 4,
  PlatformUnsupported = 5,
  DesktopDisconnected = 6,
  NotEnabledLocally = 7,
  NotEnabledInConnectedDesktopApp = 8,
  NativeMessagingPermissionMissing = 9,
}

type Message = {
  command: string;
  messageId?: number;
  userId?: string;
  timestamp?: number;
  publicKey?: string;
};

type OuterMessage = {
  message: Message | EncryptedMessage;
  appId: string;
};

type EncryptedMessage = {
  encryptedString: string;
  encryptionType: number;
  data: string;
  iv: string;
  mac: string;
};

type ReceivedMessage = {
  timestamp: number;
  command: string;
  messageId: number;
  response?: unknown;
  userKeyB64?: string;
};

type ReceivedMessageOuter = {
  command: string;
  appId: string;
  messageId?: number;
  message?: ReceivedMessage | EncryptedMessage;
  sharedSecret?: string;
};

type Callback = {
  resolver: (value: ReceivedMessage) => void;
  rejecter: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type SecureChannel = {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  sharedSecret?: Buffer;
  setupResolve?: () => void;
  setupReject?: (reason?: unknown) => void;
};

/**
 * Native messaging client for communicating with the Bitwarden desktop app.
 *
 * This implements the same IPC protocol used by the browser extension:
 * 1. Connect to the desktop app via Unix socket / named pipe
 * 2. Set up encrypted communication using RSA key exchange
 * 3. Send/receive encrypted commands (biometric unlock, status checks, etc.)
 */
export class NativeMessagingClient {
  private connected = false;
  private connecting = false;
  private appId: string;

  private secureChannel: SecureChannel | null = null;
  private messageId = 0;
  private callbacks = new Map<number, Callback>();

  private ipcSocket: IpcSocketService;
  private userId: string | null = null;

  constructor(appId: string, userId?: string) {
    this.appId = appId;
    this.userId = userId ?? null;
    this.ipcSocket = new IpcSocketService();
  }

  /**
   * Check if the desktop app is available (socket exists).
   */
  async isDesktopAppAvailable(): Promise<boolean> {
    return this.ipcSocket.isSocketAvailable();
  }

  /**
   * Connect to the desktop app.
   */
  async connect(): Promise<void> {
    if (this.connected || this.connecting) {
      return;
    }

    this.connecting = true;

    try {
      await this.ipcSocket.connect();

      // Set up message handler
      this.ipcSocket.onMessage((message) => {
        this.handleMessage(message as ReceivedMessageOuter);
      });

      this.ipcSocket.onDisconnect(() => {
        this.connected = false;
        this.secureChannel = null;

        // Clear timeouts and reject all pending callbacks
        for (const callback of this.callbacks.values()) {
          clearTimeout(callback.timeout);
          callback.rejecter(new Error("Disconnected from Desktop app"));
        }
        this.callbacks.clear();
      });

      this.connected = true;
      this.connecting = false;
    } catch (e) {
      this.connecting = false;
      throw e;
    }
  }

  /**
   * Disconnect from the desktop app.
   */
  disconnect(): void {
    this.ipcSocket.disconnect();
    this.connected = false;
    this.secureChannel = null;
  }

  /**
   * Send a command to the desktop app and wait for a response.
   */
  async callCommand(
    message: Message,
    timeoutMs: number = DEFAULT_TIMEOUT,
  ): Promise<ReceivedMessage> {
    const messageId = this.messageId++;

    const callback = new Promise<ReceivedMessage>((resolver, rejecter) => {
      const timeout = setTimeout(() => {
        if (this.callbacks.has(messageId)) {
          this.callbacks.delete(messageId);
          rejecter(
            new Error("Message timed out waiting for Desktop app response"),
          );
        }
      }, timeoutMs);

      this.callbacks.set(messageId, { resolver, rejecter, timeout });
    });

    message.messageId = messageId;

    try {
      await this.send(message);
    } catch (e) {
      const cb = this.callbacks.get(messageId);
      if (cb) {
        clearTimeout(cb.timeout);
        this.callbacks.delete(messageId);
        cb.rejecter(e instanceof Error ? e : new Error(String(e)));
      }
    }

    return callback;
  }

  /**
   * Get biometrics status from the desktop app.
   */
  async getBiometricsStatus(): Promise<BiometricsStatus> {
    const response = await this.callCommand({
      command: BiometricsCommands.GetBiometricsStatus,
    });
    return response.response as BiometricsStatus;
  }

  /**
   * Get biometrics status for a specific user.
   */
  async getBiometricsStatusForUser(userId: string): Promise<BiometricsStatus> {
    const response = await this.callCommand({
      command: BiometricsCommands.GetBiometricsStatusForUser,
      userId: userId,
    });
    return response.response as BiometricsStatus;
  }

  /**
   * Unlock with biometrics for a specific user.
   * Returns the user key if successful.
   */
  async unlockWithBiometricsForUser(userId: string): Promise<string | null> {
    const response = await this.callCommand(
      {
        command: BiometricsCommands.UnlockWithBiometricsForUser,
        userId: userId,
      },
      USER_INTERACTION_TIMEOUT,
    );

    if (response.response) {
      return response.userKeyB64 ?? null;
    }

    return null;
  }

  /**
   * Send a message to the desktop app (encrypted if secure channel is established).
   */
  private async send(message: Message): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    message.userId = this.userId ?? undefined;
    message.timestamp = Date.now();

    this.postMessage({
      appId: this.appId,
      message: await this.encryptMessage(message),
    });
  }

  /**
   * Encrypt a message using the secure channel's shared secret.
   */
  private async encryptMessage(
    message: Message,
  ): Promise<EncryptedMessage | Message> {
    if (this.secureChannel?.sharedSecret == null) {
      await this.secureCommunication();
    }

    // biome-ignore lint/style/noNonNullAssertion: guaranteed by secureCommunication() above
    const sharedSecret = this.secureChannel!.sharedSecret!;
    const messageJson = JSON.stringify(message);

    // Use AES-256-CBC encryption (matching Bitwarden's EncryptionType.AesCbc256_HmacSha256_B64 = 2)
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      sharedSecret.subarray(0, 32),
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update(messageJson, "utf8"),
      cipher.final(),
    ]);

    // Create HMAC using the second half of the key
    const macKey = sharedSecret.subarray(32, 64);
    const hmac = crypto.createHmac("sha256", macKey);
    hmac.update(iv);
    hmac.update(encrypted);
    const mac = hmac.digest();

    return {
      encryptionType: 2, // AesCbc256_HmacSha256_B64
      encryptedString: `2.${iv.toString("base64")}|${encrypted.toString("base64")}|${mac.toString("base64")}`,
      iv: iv.toString("base64"),
      data: encrypted.toString("base64"),
      mac: mac.toString("base64"),
    };
  }

  /**
   * Post a message to the IPC socket.
   */
  private postMessage(message: OuterMessage): void {
    try {
      this.ipcSocket.sendMessage(message);
    } catch (e) {
      this.secureChannel = null;
      this.connected = false;
      throw e;
    }
  }

  /**
   * Handle incoming messages from the desktop app.
   */
  private async handleMessage(message: ReceivedMessageOuter): Promise<void> {
    if (DEBUG) {
      console.error(
        `[DEBUG] Received message:`,
        JSON.stringify(message, null, 2),
      );
    }

    switch (message.command) {
      case "setupEncryption":
        if (message.appId !== this.appId) {
          return;
        }
        await this.handleSetupEncryption(message);
        break;

      case "invalidateEncryption": {
        if (message.appId !== this.appId) {
          return;
        }
        const invalidError = new Error(
          "Encryption channel invalidated by Desktop app",
        );
        if (this.secureChannel?.setupReject) {
          this.secureChannel.setupReject(invalidError);
        }
        this.secureChannel = null;
        for (const callback of this.callbacks.values()) {
          clearTimeout(callback.timeout);
          callback.rejecter(invalidError);
        }
        this.callbacks.clear();
        this.connected = false;
        this.ipcSocket.disconnect();
        break;
      }

      case "wrongUserId": {
        const wrongUserError = new Error(
          "Account mismatch: CLI and Desktop app are logged into different accounts",
        );
        if (this.secureChannel?.setupReject) {
          this.secureChannel.setupReject(wrongUserError);
        }
        this.secureChannel = null;
        for (const callback of this.callbacks.values()) {
          clearTimeout(callback.timeout);
          callback.rejecter(wrongUserError);
        }
        this.callbacks.clear();
        this.connected = false;
        this.ipcSocket.disconnect();
        break;
      }

      case "verifyDesktopIPCFingerprint":
        await this.showFingerprint();
        break;

      default:
        // Ignore messages for other apps
        if (message.appId !== this.appId) {
          return;
        }

        if (message.message != null) {
          await this.handleEncryptedMessage(message.message);
        }
    }
  }

  /**
   * Handle the setupEncryption response from the desktop app.
   */
  private async handleSetupEncryption(
    message: ReceivedMessageOuter,
  ): Promise<void> {
    if (DEBUG) {
      console.error(
        `[DEBUG] handleSetupEncryption called, sharedSecret present: ${message.sharedSecret != null}`,
      );
    }

    if (message.sharedSecret == null) {
      if (DEBUG) {
        console.error(`[DEBUG] No sharedSecret in message`);
      }
      return;
    }

    if (this.secureChannel == null) {
      if (DEBUG) {
        console.error(`[DEBUG] No secureChannel setup`);
      }
      return;
    }

    // Decrypt the shared secret using our private key (RSA-OAEP with SHA-1)
    const encrypted = Buffer.from(message.sharedSecret, "base64");
    if (DEBUG) {
      console.error(
        `[DEBUG] Encrypted sharedSecret length: ${encrypted.length}`,
      );
    }

    const decrypted = crypto.privateDecrypt(
      {
        key: this.secureChannel.privateKey,
        oaepHash: "sha1",
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      encrypted,
    );

    this.secureChannel.sharedSecret = decrypted;

    if (DEBUG) {
      console.error(
        `[DEBUG] Decrypted sharedSecret length: ${this.secureChannel.sharedSecret.length}`,
      );
    }

    if (this.secureChannel.setupResolve) {
      this.secureChannel.setupResolve();
    }
  }

  /**
   * Handle an encrypted message from the desktop app.
   */
  private async handleEncryptedMessage(
    rawMessage: ReceivedMessage | EncryptedMessage,
  ): Promise<void> {
    if (this.secureChannel?.sharedSecret == null) {
      return;
    }

    let message: ReceivedMessage;

    if ("encryptionType" in rawMessage || "encryptedString" in rawMessage) {
      // Decrypt the message
      const encMsg = rawMessage as EncryptedMessage;
      const iv = Buffer.from(encMsg.iv, "base64");
      const data = Buffer.from(encMsg.data, "base64");
      const mac = Buffer.from(encMsg.mac, "base64");

      const sharedSecret = this.secureChannel.sharedSecret;
      const encKey = sharedSecret.subarray(0, 32);
      const macKey = sharedSecret.subarray(32, 64);

      // Verify HMAC
      const hmac = crypto.createHmac("sha256", macKey);
      hmac.update(iv);
      hmac.update(data);
      const expectedMac = hmac.digest();

      if (!crypto.timingSafeEqual(mac, expectedMac)) {
        throw new Error("Message integrity check failed");
      }

      // Decrypt
      const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
      const decrypted = Buffer.concat([
        decipher.update(data),
        decipher.final(),
      ]);
      message = JSON.parse(decrypted.toString("utf8"));
    } else {
      message = rawMessage as ReceivedMessage;
    }

    this.processDecryptedMessage(message);
  }

  /**
   * Process a decrypted message and resolve any pending callbacks.
   */
  private processDecryptedMessage(message: ReceivedMessage): void {
    if (DEBUG) {
      console.error(
        `[DEBUG] Decrypted message:`,
        JSON.stringify(message, null, 2),
      );
    }

    if (Math.abs(message.timestamp - Date.now()) > MESSAGE_VALID_TIMEOUT) {
      if (DEBUG) {
        console.error(
          `[DEBUG] Message too old, ignoring. Timestamp: ${message.timestamp}, now: ${Date.now()}`,
        );
      }
      return;
    }

    const messageId = message.messageId;

    if (this.callbacks.has(messageId)) {
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by .has() check above
      const callback = this.callbacks.get(messageId)!;
      clearTimeout(callback.timeout);
      this.callbacks.delete(messageId);
      callback.resolver(message);
    } else if (DEBUG) {
      console.error(`[DEBUG] No callback found for messageId: ${messageId}`);
    }
  }

  /**
   * Set up secure communication with RSA key exchange.
   */
  private async secureCommunication(): Promise<void> {
    // Generate RSA key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });

    // Export public key in SPKI/DER format (base64 encoded)
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    const publicKeyB64 = publicKeyDer.toString("base64");

    const setupMessage = {
      appId: this.appId,
      message: {
        command: "setupEncryption",
        publicKey: publicKeyB64,
        userId: this.userId ?? undefined,
        messageId: this.messageId++,
        timestamp: Date.now(),
      },
    };

    if (DEBUG) {
      console.error(
        `[DEBUG] Sending setupEncryption:`,
        JSON.stringify(
          {
            ...setupMessage,
            message: {
              ...setupMessage.message,
              publicKey: `${publicKeyB64.slice(0, 50)}...`,
            },
          },
          null,
          2,
        ),
      );
    }

    this.postMessage(setupMessage);

    return new Promise((resolve, reject) => {
      this.secureChannel = {
        publicKey,
        privateKey,
        setupResolve: resolve,
        setupReject: reject,
      };

      // Timeout for key exchange
      setTimeout(() => {
        if (this.secureChannel && !this.secureChannel.sharedSecret) {
          reject(new Error("Secure channel setup timed out"));
        }
      }, DEFAULT_TIMEOUT);
    });
  }

  /**
   * Display the fingerprint for verification.
   */
  private async showFingerprint(): Promise<void> {
    if (this.secureChannel?.publicKey == null) {
      return;
    }

    // Generate fingerprint from public key
    const publicKeyDer = this.secureChannel.publicKey.export({
      type: "spki",
      format: "der",
    });
    const hash = crypto.createHash("sha256").update(publicKeyDer).digest();

    // Format as 5 groups of alphanumeric characters (like Bitwarden)
    const fingerprint = hash.toString("hex").slice(0, 25).toUpperCase();
    const formatted = fingerprint.match(/.{1,5}/g)?.join("-") || fingerprint;

    // Write to stderr so it doesn't interfere with command output
    const dim = "\x1b[2m";
    const cyan = "\x1b[36m";
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";

    console.error("");
    console.error(`${bold}Bitwarden Desktop App Verification${reset}`);
    console.error(
      "Verify this fingerprint matches the one shown in the Desktop app:",
    );
    console.error("");
    console.error(`${dim}  ${cyan}${formatted}${reset}`);
    console.error("");
    console.error("Accept the connection in the Desktop app to continue.");
    console.error("");
  }
}
