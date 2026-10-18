import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scoreBucket } from "../../src/impulse.js";
import { offersSleep } from "../../src/score-band.js";
import { showSleepControl, type OverlayModel } from "./overlay.js";

describe("Sleep on it", () => {
  it("shows the button only for scores 2 and 3", () => {
    const cases = [
      { score: 1, shown: false },
      { score: 2, shown: true },
      { score: 3, shown: true },
      { score: 4, shown: false },
      { score: 5, shown: false },
    ] as const;
    for (const entry of cases) {
      const bucket = scoreBucket(entry.score);
      assert.equal(offersSleep(bucket), entry.shown, `offersSleep ${entry.score}`);
      assert.equal(showSleepControl(card(entry.score, bucket)), entry.shown, `button ${entry.score}`);
    }
    assert.equal(showSleepControl(card(null, null)), false);
  });
});

function card(score: number | null, bucket: OverlayModel["scoreBucket"]): Pick<OverlayModel, "necessity" | "error" | "scoreBucket"> {
  return {
    necessity: "unnecessary",
    error: null,
    scoreBucket: score == null ? null : bucket,
  };
}
