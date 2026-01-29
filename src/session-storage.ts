import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * AesCbc256_HmacSha256_B64 encryption type (matches Bitwarden's format)
 */
const ENCRYPTION_TYPE = 2;

/**
 * Get the CLI data directory path for the current platform.
 */
function getCliDataDir(): string {
  if (process.env.BITWARDENCLI_APPDATA_DIR) {
    return path.resolve(process.env.BITWARDENCLI_APPDATA_DIR);
  }

  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === "darwin") {
    return path.join(homeDir, "Library/Application Support/Bitwarden CLI");
  } else if (platform === "win32") {
    return path.join(process.env.APPDATA ?? homeDir, "Bitwarden CLI");
  } else {
    // Linux
    const configDir =
      process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
    return path.join(configDir, "Bitwarden CLI");
  }
}

/**
 * Generate a new session key (64 random bytes, base64 encoded).
 */
export function generateSessionKey(): string {
  const keyBytes = crypto.randomBytes(64);
  return keyBytes.toString("base64");
}

/**
 * Encrypt data using AES-256-CBC with HMAC-SHA256 (Bitwarden's type 2 format).
 *
 * @param data - The data to encrypt (as Uint8Array)
 * @param sessionKey - The session key (base64 encoded, 64 bytes when decoded)
 * @returns Encrypted data as base64 string
 */
function encryptWithSessionKey(data: Uint8Array, sessionKey: string): string {
  // Decode session key - first 32 bytes for AES, last 32 for HMAC
  const keyBytes = Buffer.from(sessionKey, "base64");
  if (keyBytes.length !== 64) {
    throw new Error("Session key must be 64 bytes");
  }

  const encKey = keyBytes.subarray(0, 32);
  const macKey = keyBytes.subarray(32, 64);

  // Generate random IV
  const iv = crypto.randomBytes(16);

  // Encrypt with AES-256-CBC
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);

  // Calculate HMAC-SHA256 over IV + ciphertext
  const hmac = crypto.createHmac("sha256", macKey);
  hmac.update(iv);
  hmac.update(encrypted);
  const mac = hmac.digest();

  // Assemble: [encType, iv, mac, ciphertext]
  const result = Buffer.alloc(1 + 16 + 32 + encrypted.length);
  result.writeUInt8(ENCRYPTION_TYPE, 0);
  iv.copy(result, 1);
  mac.copy(result, 17);
  encrypted.copy(result, 49);

  return result.toString("base64");
}

/**
 * Read the CLI's data.json file.
 */
function readCliData(): Record<string, unknown> {
  const dataPath = path.join(getCliDataDir(), "data.json");

  try {
    const content = fs.readFileSync(dataPath, "utf-8");
    return content ? JSON.parse(content) : {};
  } catch {
    return {};
  }
}

/**
 * Get the active user ID from CLI's data storage.
 */
export function getActiveUserId(): string | null {
  const data = readCliData();
  const userId = data.global_account_activeAccountId;
  return typeof userId === "string" ? userId : null;
}

/**
 * Write to the CLI's data.json file.
 */
function writeCliData(data: Record<string, unknown>): void {
  const dataDir = getCliDataDir();
  const dataPath = path.join(dataDir, "data.json");

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  // Write with restrictive permissions
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Store the user key in CLI's data storage, encrypted with the session key.
 *
 * This mimics what the CLI does internally:
 * - Encrypts the user key with BW_SESSION
 * - Stores it in data.json with key "__PROTECTED__{userId}_user_auto"
 *
 * @param userKeyB64 - The user key from biometric unlock (base64 encoded)
 * @param userId - The user ID
 * @param sessionKey - The BW_SESSION key (base64 encoded, 64 bytes)
 */
export function storeUserKeyForSession(
  userKeyB64: string,
  userId: string,
  sessionKey: string,
): void {
  // The user key is already base64 - convert to bytes for encryption
  const userKeyBytes = Buffer.from(userKeyB64, "base64");

  // Encrypt the user key with the session key
  const encryptedUserKey = encryptWithSessionKey(userKeyBytes, sessionKey);

  // Store in CLI's data.json
  const storageKey = `__PROTECTED__${userId}_user_auto`;

  const data = readCliData();
  data[storageKey] = encryptedUserKey;
  writeCliData(data);
}

/**
 * Clean up the stored user key.
 *
 * @param userId - The user ID
 */
export function clearStoredUserKey(userId: string): void {
  const storageKey = `__PROTECTED__${userId}_user_auto`;

  const data = readCliData();
  delete data[storageKey];
  writeCliData(data);
}
