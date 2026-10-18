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
  return {
    mongodbUri: uri.length > 0 ? uri : null,
    jwtSecret: jwtSecret.length > 0 ? jwtSecret : null,
    backboardEnabled: apiKey.length > 0,
  };
}
