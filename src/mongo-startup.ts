export type AccountMongoConfig = {
  mongodbUri: string | null;
  jwtSecret: string | null;
};

/**
 * Options for the app's Mongoose connect.
 * An Atlas URI with no /dbname path otherwise uses the driver default "test".
 * MONGODB_DB overrides; the default matches check:mongo, which uses "simmer".
 */
export function mongoConnectOptions(env: NodeJS.ProcessEnv = process.env): { dbName: string } {
  return { dbName: env.MONGODB_DB?.trim() || "simmer" };
}

const MISSING_JWT_WARNING =
  "MONGODB_URI is set but JWT_SECRET is not. Signup will return 503 and the /purchases router will not be mounted.";

/** Startup notice only. Does not throw; signup stays 503 and /purchases stays unmounted. */
export function warnIfMongoWithoutJwt(
  config: AccountMongoConfig,
  warn: (message: string) => void = console.warn,
): void {
  if (config.mongodbUri && !config.jwtSecret) {
    warn(MISSING_JWT_WARNING);
  }
}
