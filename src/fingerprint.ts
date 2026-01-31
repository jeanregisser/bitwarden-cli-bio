import * as crypto from "node:crypto";
import { EFFLongWordList } from "./wordlist";

/**
 * HKDF-Expand (RFC 5869) - the expand step only.
 * Derives output keying material from a pseudorandom key.
 */
function hkdfExpand(
  prk: Buffer,
  info: string,
  outputLength: number,
): Buffer {
  const hashLen = 32; // SHA-256 output length
  const n = Math.ceil(outputLength / hashLen);
  const okm = Buffer.alloc(n * hashLen);
  let prev = Buffer.alloc(0);

  for (let i = 1; i <= n; i++) {
    const hmac = crypto.createHmac("sha256", prk);
    hmac.update(prev);
    hmac.update(info, "utf8");
    hmac.update(Buffer.from([i]));
    prev = hmac.digest();
    prev.copy(okm, (i - 1) * hashLen);
  }

  return okm.subarray(0, outputLength);
}

/**
 * Convert a hash to a word-based phrase using the EFF Long Wordlist.
 * Matches Bitwarden's hashPhrase algorithm.
 */
function hashPhrase(hash: Buffer): string[] {
  const minimumEntropy = 64;
  const entropyPerWord = Math.log(EFFLongWordList.length) / Math.log(2);
  let numWords = Math.ceil(minimumEntropy / entropyPerWord);

  const phrase: string[] = [];
  let n = BigInt(0);
  for (const byte of hash) {
    n = n * 256n + BigInt(byte);
  }

  const wordListLen = BigInt(EFFLongWordList.length);
  while (numWords--) {
    const remainder = Number(n % wordListLen);
    n = n / wordListLen;
    phrase.push(EFFLongWordList[remainder]);
  }
  return phrase;
}

/**
 * Generate a fingerprint phrase matching Bitwarden Desktop's format.
 *
 * Algorithm: SHA-256(publicKey) → HKDF-Expand(hash, appId, 32) → word phrase
 */
export function getFingerprint(
  fingerprintMaterial: string,
  publicKey: Buffer,
): string[] {
  const keyFingerprint = crypto.createHash("sha256").update(publicKey).digest();
  const userFingerprint = hkdfExpand(keyFingerprint, fingerprintMaterial, 32);
  return hashPhrase(userFingerprint);
}
