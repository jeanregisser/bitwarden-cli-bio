import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
    const configDir =
      process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
    return path.join(configDir, "Bitwarden CLI");
  }
}

/**
 * Read the CLI's data.json file.
 */
function readCliData(): Record<string, unknown> {
  const dataPath = path.join(getCliDataDir(), "data.json");
  const content = fs.readFileSync(dataPath, "utf-8");
  return JSON.parse(content);
}

/**
 * Get the active user ID from CLI's data.json.
 */
export function getActiveUserId(): string | null {
  const data = readCliData();
  const userId = data["global_account_activeAccountId"];
  return typeof userId === "string" ? userId : null;
}

/**
 * Extract and decrypt the user key from CLI's data.json.
 *
 * The encrypted user key is stored at `__PROTECTED__<userId>_user_auto`
 * in Bitwarden's AesCbc256_HmacSha256_B64 format (type 2):
 *   [1 byte type][16 bytes IV][32 bytes MAC][ciphertext]
 *
 * The session key (BW_SESSION) is 64 bytes base64-encoded:
 *   - First 32 bytes: AES-256 encryption key
 *   - Last 32 bytes: HMAC-SHA256 key
 *
 * @param userId - The active user ID
 * @param sessionKey - The BW_SESSION value (base64-encoded, 64 bytes decoded)
 * @returns The decrypted user key as a base64 string
 */
export function extractUserKey(userId: string, sessionKey: string): string {
  const data = readCliData();
  const storageKey = `__PROTECTED__${userId}_user_auto`;
  const encrypted = data[storageKey];

  if (typeof encrypted !== "string") {
    throw new Error(
      `No encrypted user key found at ${storageKey} in data.json`
    );
  }

  // Decode the encrypted blob
  const blob = Buffer.from(encrypted, "base64");

  // Parse: [type: 1 byte][IV: 16 bytes][MAC: 32 bytes][ciphertext: rest]
  if (blob.length < 49) {
    throw new Error("Encrypted user key blob too short");
  }

  const encType = blob.readUInt8(0);
  if (encType !== 2) {
    throw new Error(
      `Unexpected encryption type: ${encType} (expected 2 = AesCbc256_HmacSha256_B64)`
    );
  }

  const iv = blob.subarray(1, 17);
  const mac = blob.subarray(17, 49);
  const ciphertext = blob.subarray(49);

  // Decode session key
  const keyBytes = Buffer.from(sessionKey, "base64");
  if (keyBytes.length !== 64) {
    throw new Error(
      `Session key must be 64 bytes, got ${keyBytes.length}`
    );
  }

  const encKey = keyBytes.subarray(0, 32);
  const macKey = keyBytes.subarray(32, 64);

  // Verify HMAC-SHA256 over IV + ciphertext
  const hmac = crypto.createHmac("sha256", macKey);
  hmac.update(iv);
  hmac.update(ciphertext);
  const expectedMac = hmac.digest();

  if (!crypto.timingSafeEqual(mac, expectedMac)) {
    throw new Error("HMAC verification failed - session key may be wrong");
  }

  // Decrypt with AES-256-CBC
  const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("base64");
}
