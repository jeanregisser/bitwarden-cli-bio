import { spawn } from "child_process";
import { isPassthroughCommand } from "./passthrough";
import { attemptBiometricUnlock } from "./biometrics";
import { generateSessionKey, storeUserKeyForSession } from "./session-storage";

/**
 * Get the path to the official bw CLI.
 *
 * Looks for 'bw' in PATH, excluding our own wrapper if it's aliased.
 */
function getBwPath(): string {
  // For now, just use 'bw' and let the shell resolve it
  // TODO: Handle case where bwbio is aliased as bw
  return "bw";
}

/**
 * Execute the official bw CLI with the given arguments.
 *
 * @param args - Command line arguments to pass to bw
 * @param sessionKey - Optional BW_SESSION value to set
 * @returns Exit code from bw
 */
async function executeBw(args: string[], sessionKey?: string): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env };

    if (sessionKey) {
      env.BW_SESSION = sessionKey;
    }

    const child = spawn(getBwPath(), args, {
      stdio: "inherit",
      env,
      // On Windows, spawn needs shell to resolve .cmd wrappers (e.g. bw.cmd)
      shell: process.platform === "win32",
    });

    child.on("error", (err) => {
      console.error(`Failed to execute bw: ${err.message}`);
      resolve(1);
    });

    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  });
}

/**
 * Handle the 'unlock' command specially to output BW_SESSION export.
 */
async function handleUnlock(
  args: string[],
  sessionKey: string
): Promise<number> {
  // Check if --raw flag is present
  const isRaw = args.includes("--raw");

  if (isRaw) {
    // Just output the session key
    console.log(sessionKey);
  } else {
    // Output in a format suitable for eval
    console.log(`export BW_SESSION="${sessionKey}"`);
    console.log(
      `# Run this command to set the session: eval $(bwbio unlock)`
    );
  }

  return 0;
}

/**
 * Main entry point for the CLI wrapper.
 *
 * Decision flow:
 * 1. If BW_SESSION is already set, pass through to bw
 * 2. If command is passthrough, delegate to bw directly
 * 3. Otherwise, attempt biometric unlock and delegate with session
 */
export async function main(args: string[]): Promise<number> {
  // 1. Check if BW_SESSION is already set
  if (process.env.BW_SESSION) {
    return executeBw(args);
  }

  // 2. Check if this is a passthrough command
  if (isPassthroughCommand(args)) {
    return executeBw(args);
  }

  // 3. Attempt biometric unlock
  console.error("Attempting biometric unlock...");

  const result = await attemptBiometricUnlock({
    verbose: process.env.BWBIO_VERBOSE === "1",
  });

  if (result.success && result.userKeyB64 && result.userId) {
    // Generate a new session key and store the user key
    const sessionKey = generateSessionKey();
    storeUserKeyForSession(result.userKeyB64, result.userId, sessionKey);

    // Check if this is an explicit 'unlock' command
    if (args[0] === "unlock") {
      return handleUnlock(args, sessionKey);
    }

    // Execute the requested command with the session
    return executeBw(args, sessionKey);
  }

  // Biometric unlock failed - fall back to bw
  if (result.shouldFallback) {
    console.error(
      `Biometric unlock unavailable: ${result.error}. Falling back to CLI...`
    );
    return executeBw(args);
  }

  // Non-recoverable error
  console.error(`Biometric unlock failed: ${result.error}`);
  return 1;
}
