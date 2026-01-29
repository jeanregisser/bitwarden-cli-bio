import * as crypto from "crypto";
import { NativeMessagingClient, BiometricsStatus } from "./ipc";
import { getActiveUserId } from "./session-storage";

/**
 * Result of a biometric unlock attempt.
 */
export type BiometricUnlockResult =
  | {
      success: true;
      /** The user's encryption key (base64 encoded) - NOT the session key */
      userKeyB64: string;
      userId: string;
    }
  | {
      success: false;
      error: string;
    };

/**
 * Options for biometric unlock.
 */
export interface BiometricUnlockOptions {
  userId?: string;
  verbose?: boolean;
}

/**
 * Generate a unique app ID for this CLI instance.
 */
function generateAppId(): string {
  return `bwbio-${crypto.randomUUID()}`;
}

/**
 * Attempt to unlock the vault using biometrics via the Desktop app.
 */
export async function attemptBiometricUnlock(
  options: BiometricUnlockOptions = {}
): Promise<BiometricUnlockResult> {
  // Get the user ID from CLI data - this is required for the desktop app
  const userId = options.userId || getActiveUserId();
  if (!userId) {
    return {
      success: false,
      error: "No user ID available - please log in first",
    };
  }

  const appId = generateAppId();
  const client = new NativeMessagingClient(appId, userId);

  try {
    // Check if desktop app is available
    const available = await client.isDesktopAppAvailable();
    if (!available) {
      return {
        success: false,
        error: "Bitwarden Desktop app is not running",
      };
    }

    if (options.verbose) {
      console.error("Connecting to Bitwarden Desktop...");
    }

    await client.connect();

    // Get user-specific biometrics status
    if (options.verbose) {
      console.error("Checking biometrics status...");
    }

    const userStatus = await client.getBiometricsStatusForUser(userId);

    // BiometricsStatus is an enum - Available (0) means biometrics can be used
    if (userStatus !== BiometricsStatus.Available) {
      const statusName = BiometricsStatus[userStatus] || `Unknown(${userStatus})`;
      return {
        success: false,
        error: `Biometrics not available: ${statusName}`,
      };
    }

    // Request biometric unlock
    if (options.verbose) {
      console.error("Requesting biometric authentication...");
    }

    const userKey = await client.unlockWithBiometricsForUser(userId);

    if (!userKey) {
      return {
        success: false,
        error: "Biometric unlock was denied or failed",
      };
    }

    return {
      success: true,
      userKeyB64: userKey,
      userId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    return {
      success: false,
      error,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Check biometrics availability without attempting unlock.
 */
export async function checkBiometricsAvailable(): Promise<boolean> {
  const userId = getActiveUserId();
  if (!userId) {
    return false;
  }

  const appId = generateAppId();
  const client = new NativeMessagingClient(appId, userId);

  try {
    const available = await client.isDesktopAppAvailable();
    if (!available) {
      return false;
    }

    await client.connect();
    const status = await client.getBiometricsStatusForUser(userId);
    return status === BiometricsStatus.Available;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}
