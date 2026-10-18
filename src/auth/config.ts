/** Account and Backboard flags. Missing values leave the desk demo on its in-memory cart store. */
export type AccountConfig = {
  mongodbUri: string | null;
  jwtSecret: string | null;
  backboardEnabled: boolean;
};

export function readAccountConfig(env: NodeJS.ProcessEnv = process.env): AccountConfig {
  const apiKey = env.BACKBOARD_API_KEY?.trim() ?? "";
  const uri = env.MONGODB_URI?.trim() ?? "";
  const jwtSecret = env.JWT_SECRET?.trim() ?? "";
  if (jwtSecret.length > 0) {
    requireJwtSecret(jwtSecret);
  }
  return {
    mongodbUri: uri.length > 0 ? uri : null,
    jwtSecret: jwtSecret.length > 0 ? jwtSecret : null,
    backboardEnabled: apiKey.length > 0,
  };
}

/** HS256 keys shorter than 32 bytes are rejected at startup. An unset secret still boots the demo. */
export function requireJwtSecret(secret: string): void {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("JWT_SECRET must be at least 32 bytes.");
  }
}
