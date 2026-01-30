/**
 * Log a message to stderr unless BW_QUIET is set.
 */
export function log(message: string): void {
  if (process.env.BW_QUIET !== "true") {
    console.error(message);
  }
}

/**
 * Log a message to stderr only when BWBIO_VERBOSE is set (and not quiet).
 */
export function logVerbose(message: string): void {
  if (process.env.BWBIO_VERBOSE === "true" && process.env.BW_QUIET !== "true") {
    console.error(message);
  }
}
