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
    assert.equal(lockGlance([item({ status: "vault" })]), "In the Vault");
  });

  it("uses one line for wait, buy, and vault time", () => {
    assert.equal(oneLineVerdict(item(), NOW), "Wait ~2 mo, save ~$557");
    assert.equal(oneLineVerdict(item({ decision: { ...item().decision!, action: "unlock", savingsCents: 0 } }), NOW), "Buy now");
    assert.equal(
      oneLineVerdict(item({ status: "vault", vaultUntil: "2026-10-19T02:00:00.000Z" }), NOW),
      "Vault · 14h left",
    );
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
