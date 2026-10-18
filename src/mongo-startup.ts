export type AccountMongoConfig = {
  mongodbUri: string | null;
  jwtSecret: string | null;
};

/**
 * Options for the app's Mongoose connect.
 * An Atlas URI with no /dbname path otherwise uses the driver default "test".
 * MONGODB_DB, when set, always wins. A database already named in the URI is
 * left alone. Otherwise the default is "simmer", matching check:mongo.
 */
export function mongoConnectOptions(env: NodeJS.ProcessEnv = process.env): { dbName?: string } {
  const configured = env.MONGODB_DB?.trim() ?? "";
  if (configured.length > 0) {
    return { dbName: configured };
  }
  if (uriNamesDatabase(env.MONGODB_URI)) {
    return {};
  }
  return { dbName: "simmer" };
}

/** True when the URI path names a database. An empty path or query string does not. */
function uriNamesDatabase(uri: string | undefined): boolean {
  const trimmed = uri?.trim() ?? "";
  if (trimmed.length === 0) {
    return false;
  }
  const beforeQuery = trimmed.split("?")[0] ?? "";
  const scheme = beforeQuery.indexOf("://");
  const afterScheme = scheme >= 0 ? beforeQuery.slice(scheme + 3) : beforeQuery;
  const at = afterScheme.lastIndexOf("@");
  const hostAndPath = at >= 0 ? afterScheme.slice(at + 1) : afterScheme;
  const slash = hostAndPath.indexOf("/");
  if (slash < 0) {
    return false;
  }
  return hostAndPath.slice(slash + 1).trim().length > 0;
}

const MISSING_JWT_WARNING =
  "MONGODB_URI is set but JWT_SECRET is not. Signup will return 503 and the /purchases router will not be mounted.";

const PLACEHOLDER_JWT_WARNING =
  "JWT_SECRET is set to a placeholder or default value. Replace it with a long random secret. Startup will continue.";

/**
 * Placeholder check for a secret that is already long enough for requireJwtSecret.
 * Short literals such as "changeme" throw at startup and are not warned here.
 * A long secret is treated as a placeholder when it is one repeated character,
 * or when it is only "changeme", "your-secret-here", or "placeholder" repeated.
 */
const JWT_PLACEHOLDER_WORDS = ["changeme", "your-secret-here", "placeholder"] as const;

function isObviousPlaceholderJwt(secret: string): boolean {
  const trimmed = secret.trim();
  if (new TextEncoder().encode(trimmed).byteLength < 32) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (/^(.)\1*$/.test(normalized)) {
    return true;
  }
  return JWT_PLACEHOLDER_WORDS.some((word) => {
    if (normalized.length % word.length !== 0) {
      return false;
    }
    return normalized === word.repeat(normalized.length / word.length);
  });
}

/** Startup notice only. Does not throw, and does not print the secret. */
export function warnIfMongoWithoutJwt(
  config: AccountMongoConfig,
  warn: (message: string) => void = console.warn,
): void {
  if (config.mongodbUri && !config.jwtSecret) {
    warn(MISSING_JWT_WARNING);
    return;
  }
  if (config.jwtSecret && isObviousPlaceholderJwt(config.jwtSecret)) {
    warn(PLACEHOLDER_JWT_WARNING);
  }
}
