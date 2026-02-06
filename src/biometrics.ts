import * as crypto from "node:crypto";
import { BiometricsStatus, NativeMessagingClient } from "./ipc";
import { log, logVerbose } from "./log";
import { getActiveUserId } from "./session-storage";

/**
 * Get the platform-specific biometric method name.
 */
function getBiometricMethodName(): string {
  switch (process.platform) {
    case "darwin":
      return "Touch ID";
    case "win32":
      return "Windows Hello";
    default:
      return "Polkit";
  }
}

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
    };

/**
 * Options for biometric unlock.
 */
export interface BiometricUnlockOptions {
  userId?: string;
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
  options: BiometricUnlockOptions = {},
): Promise<BiometricUnlockResult> {
  // Get the user ID from CLI data - this is required for the desktop app
  const userId = options.userId || getActiveUserId();
  if (!userId) {
    logVerbose(
      "Biometric unlock unavailable: No user ID available - please log in first",
    );
    return { success: false };
  }

  const appId = generateAppId();
  const client = new NativeMessagingClient(appId, userId);
  let connected = false;

  try {
    await client.connect();
    connected = true;

    // Get user-specific biometrics status
    logVerbose("Checking biometrics status...");

    const userStatus = await client.getBiometricsStatusForUser(userId);

    // BiometricsStatus is an enum - Available (0) means biometrics can be used
    if (userStatus !== BiometricsStatus.Available) {
      const statusName =
        BiometricsStatus[userStatus] || `Unknown(${userStatus})`;
      logVerbose(`Biometric unlock unavailable: ${statusName}`);
      return { success: false };
    }

    // Request biometric unlock
    log(
      `Authenticate with ${getBiometricMethodName()} on Desktop app to continue...`,
    );

    const userKey = await client.unlockWithBiometricsForUser(userId);

    if (!userKey) {
      log("Biometric unlock was denied or failed");
      return { success: false };
    }

    return {
      success: true,
      userKeyB64: userKey,
      userId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (connected) {
      log(`Biometric unlock failed: ${error}`);
    } else {
      logVerbose(`Biometric unlock unavailable: ${error}`);
    }
    return { success: false };
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
    await client.connect();
    const status = await client.getBiometricsStatusForUser(userId);
    return status === BiometricsStatus.Available;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}
