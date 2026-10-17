/** Docs default. Socket.IO and the HTTP client both use this origin, not a /v1 suffix. */
export const DEFAULT_API_ORIGIN = "https://api.photon.codes";

export type AgentConfig = {
  apiKey: string;
  projectId: string;
  platform: "imessage";
  agentHandle: string;
  apiOrigin: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const platform = required(env, "PHOTON_PLATFORM");
  if (platform !== "imessage") {
    throw new Error("PHOTON_PLATFORM must be imessage.");
  }

  const origin = env.PHOTON_API_ORIGIN?.trim();
  return {
    apiKey: required(env, "PHOTON_API_KEY"),
    projectId: required(env, "PHOTON_PROJECT_ID"),
    platform,
    agentHandle: required(env, "PHOTON_AGENT_HANDLE"),
    apiOrigin: origin && origin.length > 0 ? origin : DEFAULT_API_ORIGIN,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}
