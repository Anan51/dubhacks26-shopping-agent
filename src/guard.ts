export const COOLDOWN_CHOICES_MS = [120_000, 300_000, 600_000, 1_800_000] as const;

export const DEFAULT_GUARD_THRESHOLD_CENTS = 10_000;

export const DEFAULT_GUARD_COOLING_MS = 600_000;

const MAX_THRESHOLD_CENTS = 10_000_000;

export type GuardSettings = {
  enabled: boolean;
  thresholdCents: number;
  coolingMs: number;
};

export type GuardSeed = {
  coolingMs: number;
  thresholdCents: number | null;
};

/** Settings for a shopper who has not saved any yet. The guard starts on. */
export function defaultGuardSettings(seed: GuardSeed = { coolingMs: DEFAULT_GUARD_COOLING_MS, thresholdCents: null }): GuardSettings {
  return {
    enabled: true,
    thresholdCents: seed.thresholdCents ?? DEFAULT_GUARD_THRESHOLD_CENTS,
    coolingMs: isCooldownChoice(seed.coolingMs) ? seed.coolingMs : DEFAULT_GUARD_COOLING_MS,
  };
}

export function isCooldownChoice(ms: number): ms is (typeof COOLDOWN_CHOICES_MS)[number] {
  return (COOLDOWN_CHOICES_MS as readonly number[]).includes(ms);
}

/**
 * The lock applies only when the guard is on and due today is at least the threshold.
 * Under the threshold, or with the guard off, checkout completes with no lock.
 */
export function shouldLock(input: { enabled: boolean; dueTodayCents: number; thresholdCents: number }): boolean {
  return input.enabled && input.dueTodayCents >= input.thresholdCents;
}

export function parseGuardSettings(value: unknown): GuardSettings | { error: string } {
  if (!isRecord(value)) {
    return { error: "Guard settings must be an object." };
  }
  if (typeof value.enabled !== "boolean") {
    return { error: "Guard enabled must be true or false." };
  }
  if (typeof value.thresholdCents !== "number" || !Number.isInteger(value.thresholdCents) || value.thresholdCents < 0 || value.thresholdCents > MAX_THRESHOLD_CENTS) {
    return { error: "Threshold must be a whole number of cents from 0 to 10000000." };
  }
  if (typeof value.coolingMs !== "number" || !isCooldownChoice(value.coolingMs)) {
    return { error: "Cooldown must be 2, 5, 10, or 30 minutes." };
  }
  return {
    enabled: value.enabled,
    thresholdCents: value.thresholdCents,
    coolingMs: value.coolingMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
