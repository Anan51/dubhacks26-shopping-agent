import type { ScoreBucket } from "./types.js";

/** 2 and 3 are the soft band. Sleep is offered only there. */
export const SOFT_SCORE_MIN = 2;

/** 4 and above unlock. */
export const FREE_SCORE_MIN = 4;

/** True only for the soft band the sleep route accepts. */
export function offersSleep(bucket: ScoreBucket | null | undefined): boolean {
  return bucket === "soft";
}
