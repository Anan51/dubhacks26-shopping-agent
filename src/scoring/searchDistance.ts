/**
 * Backboard's search score is a distance: 0 is an identical memory.
 * After the category gate, a numeric score counts at or under 0.7,
 * and a distance around 0.88 or higher does not.
 * A same-item phone query scored about 0.44 and a Pixel query scored 0.578.
 * Pixel 9 keywords to phone, so that query matches an iPhone regret and 0.7 keeps it.
 */
export const DEFAULT_REGRET_SEARCH_MAX_DISTANCE = 0.7;

/**
 * Maximum distance for a Backboard search hit. Unset or outside [0, 1] uses 0.7.
 * A hit with no numeric score is not rejected here.
 */
export function regretSearchMaxDistance(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGRET_SEARCH_MAX_DISTANCE;
  if (typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_REGRET_SEARCH_MAX_DISTANCE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_REGRET_SEARCH_MAX_DISTANCE;
  }
  return parsed;
}

/** A missing or non-numeric score is kept. A numeric score counts only at or under the maximum distance. */
export function withinMaxDistance(score: number | null, maxDistance: number): boolean {
  if (score == null || !Number.isFinite(score)) {
    return true;
  }
  return score <= maxDistance;
}
