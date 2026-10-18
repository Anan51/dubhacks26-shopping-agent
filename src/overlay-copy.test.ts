import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GlanceItem } from "./glance.js";
import { adviceMessage, pauseSentence, priceLine, simmerKicker } from "./overlay-copy.js";

function item(overrides: Partial<GlanceItem> = {}): GlanceItem {
  return {
    code: "AB23CD",
    name: "iPhone 16 Pro",
    priceCents: 119_900,
    status: "locked",
    vaultUntil: null,
    decision: {
      action: "sleep",
      waitMonths: 2,
      savingsCents: 55_667,
      offerName: "example trade-in bundle",
      costNowCents: 158_549,
      costLaterCents: 102_882,
      tradeInNowCents: 16_000,
      tradeInLaterCents: 14_667,
      financingNowCents: 42_000,
      financingLaterCents: 35_000,
    },
    signals: { needVsWant: "unknown", urgency: "medium", currentPhoneBroken: false },
    motiveSources: {
      needVsWant: "default",
      urgency: "default",
      currentPhoneBroken: "default",
      reasonText: "default",
    },
    ...overrides,
  };
}

describe("overlay copy", () => {
  it("labels example data only when example figures are on screen", () => {
    assert.equal(simmerKicker(false), "Simmer");
    assert.equal(simmerKicker(true), "Simmer · example data");
  });

  it("says why in one sentence and hides default fields", () => {
    const plain = pauseSentence(item());
    assert.equal(plain, "Simmer paused this checkout until you reply by iMessage.");
    assert.doesNotMatch(plain, /default|unknown|Need vs want|Urgency|score/i);
    assert.equal(
      pauseSentence(
        item({
          signals: { needVsWant: "want", urgency: "low", currentPhoneBroken: false },
          motiveSources: {
            needVsWant: "keywords",
            urgency: "keywords",
            currentPhoneBroken: "keywords",
            reasonText: "default",
          },
        }),
      ),
      "This looks like a want, not a need.",
    );
    assert.equal(
      pauseSentence(
        item({
          signals: { needVsWant: "unknown", currentPhoneBroken: false },
          motiveSources: {
            needVsWant: "default",
            urgency: "default",
            currentPhoneBroken: "keywords",
            reasonText: "default",
          },
        }),
      ),
      "Your current phone works, so waiting costs you nothing.",
    );
  });

  it("keeps the why line to exactly one plain sentence", () => {
    const sources = item().motiveSources;
    assert.ok(sources);
    const cases = [
      item(),
      item({
        signals: { needVsWant: "want", urgency: "low", currentPhoneBroken: false },
        motiveSources: { ...sources, needVsWant: "keywords", urgency: "keywords" },
      }),
      item({
        signals: { needVsWant: "need", currentPhoneBroken: true },
        motiveSources: { ...sources, needVsWant: "keywords", currentPhoneBroken: "keywords" },
      }),
      item({
        signals: { needVsWant: "need" },
        motiveSources: { ...sources, needVsWant: "keywords" },
      }),
      item({
        signals: { currentPhoneBroken: true },
        motiveSources: { ...sources, currentPhoneBroken: "keywords" },
      }),
      item({
        signals: { currentPhoneBroken: false },
        motiveSources: { ...sources, currentPhoneBroken: "keywords" },
      }),
      item({ purchaseScore: 4, scoreBucket: "free", userImpulseScore: 5, justificationGrade: 3 }),
    ];
    for (const entry of cases) {
      const why = pauseSentence(entry);
      assert.equal(why.includes("\n"), false, why);
      assert.doesNotMatch(why, /[•*]|(?:^|\n)\s*[-–—]\s/u, why);
      assert.doesNotMatch(why, /\b(score|impulse|vault|bucket|grade)\b/i, why);
      assert.doesNotMatch(why, /\d/, why);
      const sentences = why.split(/[.!?]/).filter((part) => part.trim().length > 0);
      assert.equal(sentences.length, 1, why);
      assert.match(why, /[.!?]$/, why);
    }
  });

  it("sends buy, wait, or skip with the follow-through in the same text", () => {
    assert.equal(adviceMessage(item({ scoreBucket: "strict" })), "Skip. This one can wait.");
    assert.equal(adviceMessage(item({ scoreBucket: "free", decision: { ...item().decision!, action: "unlock" } })), "Buy. You can check out after you press Unlock.");
    assert.equal(adviceMessage(item({ scoreBucket: "soft" })), "Wait. Give it a little time before you check out.");
    const sources = item().motiveSources;
    assert.ok(sources);
    assert.equal(
      adviceMessage(
        item({
          scoreBucket: "soft",
          priceCents: 79_900,
          signals: { needVsWant: "need", urgency: "medium", currentPhoneBroken: false },
          motiveSources: { ...sources, needVsWant: "keywords" },
        }),
      ),
      "Wait. This looks like a need. Give it a little time before you check out.",
    );
    assert.equal(
      adviceMessage(
        item({
          scoreBucket: "free",
          signals: { needVsWant: "need", currentPhoneBroken: true },
          motiveSources: { ...sources, needVsWant: "keywords", currentPhoneBroken: "keywords" },
          decision: { ...item().decision!, action: "unlock" },
        }),
      ),
      "Buy. This looks like a need, and your current phone is broken. You can check out after you press Unlock.",
    );
  });

  it("shows the price now, and a wait figure only when that number is real", () => {
    assert.equal(priceLine(119_900, { cents: 102_882, example: true }), "Now: $1,199");
    assert.equal(priceLine(119_900, null), "Now: $1,199");
    assert.equal(priceLine(158_549, { cents: 102_882, example: false }), "Now: $1,585.49 · If you wait: $1,028.82 (estimate)");
  });
});
