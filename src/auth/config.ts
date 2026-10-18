import { Buffer } from "node:buffer";

/** HS256 needs a 256-bit key. Shorter secrets are refused when auth is turned on. */
const MIN_JWT_SECRET_BYTES = 32;

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
  if (jwtSecret.length > 0 && Buffer.byteLength(jwtSecret) < MIN_JWT_SECRET_BYTES) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes.`);
  }
  return {
    mongodbUri: uri.length > 0 ? uri : null,
    jwtSecret: jwtSecret.length > 0 ? jwtSecret : null,
    backboardEnabled: apiKey.length > 0,
  };
}
