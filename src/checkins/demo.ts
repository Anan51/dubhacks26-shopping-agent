/** Demo fire is off in production and off unless the desk demo flag is set. */
export function demoCheckInsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.WAITMATE_DEMO === "1";
}
