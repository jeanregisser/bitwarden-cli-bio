/**
 * Passthrough command detection
 *
 * These commands are passed directly to `bw` without attempting biometric unlock.
 */

const PASSTHROUGH_COMMANDS = new Set([
  "login",
  "logout",
  "lock",
  "config",
  "update",
  "completion",
  "status",
  "serve",
]);

const PASSTHROUGH_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

/**
 * Determines if the given arguments represent a passthrough command.
 *
 * Passthrough commands are executed directly without biometric unlock:
 * - Commands that don't need an unlocked vault (login, logout, status, etc.)
 * - Help and version flags
 *
 * @param args - Command line arguments (without node and script path)
 * @returns true if this is a passthrough command
 */
export function isPassthroughCommand(args: string[]): boolean {
  if (args.length === 0) {
    // No args = show help, which is passthrough
    return true;
  }

  const firstArg = args[0];

  // Check for passthrough flags anywhere in args
  if (args.some((arg) => PASSTHROUGH_FLAGS.has(arg))) {
    return true;
  }

  // Check if first arg is a passthrough command
  if (PASSTHROUGH_COMMANDS.has(firstArg)) {
    return true;
  }

  return false;
}
