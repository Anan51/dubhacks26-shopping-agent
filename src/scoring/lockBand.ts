import { assertNever, type ScoreBucket } from "../types.js";

/**
 * Impulsiveness is 1–8. 1 is very deliberate, 8 is very impulsive.
 * A shopper with nothing on file starts at 4.5.
 *
 * The existing purchase-score bands in `scoreBucket` (higher = freer checkout):
 *   1 strict, 2–3 soft, 4–5 free.
 *
 * This scale runs the other way, so the same three outcomes are:
 *   1–3 free   (deliberate; same outcome as purchase score >= 4)
 *   4–5 soft   (middle; same outcome as purchase score 2–3). 4.5 is soft.
 *   6–8 strict (impulsive; same outcome as purchase score 1)
 *
 * `legacyImpulseBase` is the 1–5 number `applyPurchaseScore` already adds to
 * the justification grade. A grade of 0 lands in the band above:
 *   1–3 → 4
 *   4–5 → 2
 *   6–8 → 1
 *
 * 4 and 2 are the old deliberate and impulsive seeds. The grade can still
 * move a shopper into the next band. The number shown to the shopper is the
 * 1–8 score, not this legacy base.
 */
export function impulseBand(score: number): ScoreBucket {
  const clamped = clampImpulseScale(score);
  if (clamped <= 3) {
    return "free";
  }
  if (clamped <= 5) {
    return "soft";
  }
  return "strict";
}

export function legacyImpulseBase(score: number): number {
  const band = impulseBand(score);
  switch (band) {
    case "free":
      return 4;
    case "soft":
      return 2;
    case "strict":
      return 1;
    default:
      return assertNever(band);
  }
}

export function formatImpulseScore(score: number): string {
  const rounded = Math.round(clampImpulseScale(score) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function clampImpulseScale(score: number): number {
  if (!Number.isFinite(score)) {
    return 4.5;
  }
  const rounded = Math.round(score * 10) / 10;
  return Math.min(8, Math.max(1, rounded));
}
