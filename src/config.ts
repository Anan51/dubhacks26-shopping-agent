/** Docs default. Socket.IO and the HTTP client both use this origin, not a /v1 suffix. */
export const DEFAULT_API_ORIGIN = "https://api.photon.codes";

/** Default cooling-off lock. Override with WAITMATE_COOLING_MS. */
export const DEFAULT_COOLING_MS = 600_000;

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

export type AppConfig = {
  port: number;
  origin: string;
  coolingMs: number;
  /** Null keeps today's behavior: every cart starts the cooling-off lock. */
  lockThresholdCents: number | null;
  demoReminderMs: number;
  demoDefault: boolean;
  /** Null uses the in-memory store. A path selects the JSON file store. */
  storePath: string | null;
  channel: "auto" | "photon" | "stub";
  xaiApiKey?: string;
  agentHandle: string | null;
};

export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = numberFrom(env.PORT ?? env.WAITMATE_PORT, 4321);
  const channelRaw = env.WAITMATE_CHANNEL?.trim() || "auto";
  const channel = channelRaw === "photon" || channelRaw === "stub" ? channelRaw : "auto";
  const xaiApiKey = env.XAI_API_KEY?.trim();
  return {
    port,
    origin: env.WAITMATE_PUBLIC_ORIGIN?.trim() || `http://localhost:${port}`,
    coolingMs: numberFrom(env.WAITMATE_COOLING_MS, DEFAULT_COOLING_MS),
    lockThresholdCents: centsFrom(env.WAITMATE_LOCK_THRESHOLD_CENTS),
    demoReminderMs: numberFrom(env.WAITMATE_DEMO_REMINDER_MS, 60_000),
    demoDefault: env.WAITMATE_DEMO === "1",
    storePath: env.WAITMATE_STORE_PATH?.trim() || null,
    channel,
    ...(xaiApiKey ? { xaiApiKey } : {}),
    agentHandle: env.PHOTON_AGENT_HANDLE?.trim() || null,
  };
}

export function photonConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.PHOTON_API_KEY?.trim() &&
      env.PHOTON_PROJECT_ID?.trim() &&
      env.PHOTON_PLATFORM?.trim() &&
      env.PHOTON_AGENT_HANDLE?.trim(),
  );
}

function centsFrom(value: string | undefined): number | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function numberFrom(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}
