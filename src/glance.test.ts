import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { breakdownLines, lockGlance, oneLineVerdict, type GlanceItem } from "./glance.js";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

function item(overrides: Partial<GlanceItem> = {}): GlanceItem {
  return {
    code: "AB23CD",
    name: "Example phone",
    priceCents: 120_000,
    status: "locked",
    vaultUntil: null,
    decision: {
      action: "sleep",
      waitMonths: 2,
      savingsCents: 55_667,
      offerName: "example trade-in bundle",
      costNowCents: 146_000,
      costLaterCents: 90_333,
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

describe("glance", () => {
  it("names Marinating when a bag is locked and Unlocked when nothing is waiting", () => {
    assert.equal(lockGlance([item()]), "Marinating");
    assert.equal(lockGlance([item({ status: "unlocked" })]), "Unlocked");
    assert.equal(lockGlance([item({ status: "vault" })]), "Paused");
  });

  it("uses one line for wait, buy, and vault time", () => {
    assert.equal(oneLineVerdict(item(), NOW), "Waiting about 2 months saves about $557.");
    assert.equal(
      oneLineVerdict(item({ decision: { ...item().decision!, action: "unlock", savingsCents: 0 } }), NOW),
      "Looks fine to buy.",
    );
    assert.equal(
      oneLineVerdict(item({ status: "vault", vaultUntil: "2026-10-19T02:00:00.000Z" }), NOW),
      "Ready again in 14 hours.",
    );
  });

  it("says whether to buy in plain words, without a score", () => {
    const free = oneLineVerdict(item({ purchaseScore: 4, scoreBucket: "free", status: "unlocked" }), NOW);
    const soft = oneLineVerdict(item({ purchaseScore: 3, scoreBucket: "soft", status: "locked" }), NOW);
    const strict = oneLineVerdict(
      item({
        purchaseScore: 1,
        scoreBucket: "strict",
        status: "vault",
        vaultUntil: "2026-10-19T12:00:00.000Z",
      }),
      NOW,
    );
    const waiting = oneLineVerdict(item({ userImpulseScore: 2, purchaseScore: null, status: "locked" }), NOW);
    assert.equal(free, "Looks fine to buy.");
    assert.equal(soft, "Worth a pause before buying.");
    assert.equal(strict, "This one can wait.");
    assert.equal(waiting, "Reply and say why you want this.");
    for (const line of [free, soft, strict, waiting]) {
      assert.equal(line.includes("\n"), false);
      assert.doesNotMatch(line, /\b(Score|Impulse|Vault)\b/);
      assert.doesNotMatch(line, /\d/);
    }
  });

  it("hides the example offer unless waiting for it saves money", () => {
    const shown = breakdownLines(item());
    assert.equal(shown.some((line) => line.label === "Example offer" && line.value.includes("Example data")), true);
    const hidden = breakdownLines(
      item({
        decision: { ...item().decision!, action: "unlock", savingsCents: 0, offerName: null, waitMonths: 0 },
      }),
    );
    assert.equal(hidden.some((line) => line.label === "Example offer"), false);
  });
});
