/** Dev routes stay open outside production. Production needs an explicit flag. */
export function devRoutesOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") {
    return env.WAITMATE_DEV_UNLOCK === "1";
  }
  return true;
}

/** The unlock button is not a graded reply. Both the flag and a non-production process are required. */
export function manualUnlockOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.WAITMATE_DEV_UNLOCK === "1";
}

/** Simulated iMessage replies. Off unless the process is not production and demo mode is explicit. */
export function demoReplyOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.WAITMATE_DEMO === "1";
}
