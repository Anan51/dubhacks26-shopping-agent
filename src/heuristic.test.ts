import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide, EXAMPLE_OWED_CENTS, MONTHLY_PAYMENT_CENTS, tradeInValueCents } from "./heuristic.js";
import type { Signals } from "./types.js";

function signals(overrides: Partial<Signals> = {}): Signals {
  return {
    deviceAgeMonths: 0,
    condition: "fine",
    problemText: "",
    problems: [],
    needVsWant: "unknown",
    urgency: "medium",
    currentPhoneBroken: false,
    reasonText: "",
    owedCents: EXAMPLE_OWED_CENTS,
    budgetCents: 0,
    dueTodayCents: 100_000,
    phonePriceCents: 100_000,
    monthlyPlanCents: 0,
    ...overrides,
  };
}

describe("tradeInValueCents", () => {
  it("follows the example curve and the condition factor", () => {
    assert.equal(tradeInValueCents(0, "fine"), 42_000);
    assert.equal(tradeInValueCents(24, "fine"), 16_000);
    assert.equal(tradeInValueCents(72, "fine"), 1_500);
    assert.equal(tradeInValueCents(96, "fine"), 1_500);
    assert.equal(tradeInValueCents(0, "broken"), 18_900);
    assert.equal(tradeInValueCents(0, "unusable"), 6_300);
  });
});

describe("decide", () => {
  it("sleeps when financing paydown beats trade-in decay", () => {
    const decision = decide(signals());
    assert.equal(decision.action, "sleep");
    assert.equal(decision.waitMonths, 12);
    assert.equal(decision.savingsCents, 28_000);
    assert.equal(decision.costNowCents, 100_000);
    assert.equal(decision.costLaterCents, 72_000);
    assert.equal(decision.financingLaterCents, 0);
    assert.equal(decision.tradeInNowCents, 42_000);
    assert.equal(decision.tradeInLaterCents, 28_000);
    assert.equal(decision.tradeInCurve.length, 13);
    assert.equal(decision.tradeInCurve[0]?.cents, 42_000);
    assert.equal(MONTHLY_PAYMENT_CENTS, 3_500);
  });

  it("sleeps for an example offer when trade-in decay alone does not save money", () => {
    const decision = decide(signals({ owedCents: 0, deviceAgeMonths: 24 }));
    assert.equal(decision.financingAction, "unlock");
    assert.ok(decision.financingSavingsCents <= 0);
    assert.equal(decision.action, "sleep");
    assert.equal(decision.signalEffect, "math");
    assert.equal(decision.offerId, "example-trade-in-bundle");
    assert.equal(decision.offerName, "example trade-in bundle");
    assert.equal(decision.offerMonthsFromNow, 2);
    assert.equal(decision.savingsCents, 18_667);
  });

  it("unlocks a needed broken phone even when waiting saves money", () => {
    const decision = decide(
      signals({
        needVsWant: "need",
        urgency: "high",
        currentPhoneBroken: true,
        reasonText: "cracked screen, battery dies by 3pm, I need it for work tomorrow",
      }),
    );
    assert.equal(decision.mathAction, "sleep");
    assert.equal(decision.action, "unlock");
    assert.equal(decision.signalEffect, "need_unlock");
    assert.ok(decision.mathSavingsCents > 0);
  });

  it("sleeps on a low-urgency want even when waiting saves nothing", () => {
    const decision = decide(
      signals({
        owedCents: 0,
        deviceAgeMonths: 24,
        needVsWant: "want",
        urgency: "low",
        currentPhoneBroken: false,
        reasonText: "the new color looks nice",
      }),
    );
    assert.equal(decision.financingAction, "unlock");
    assert.equal(decision.action, "sleep");
    assert.equal(decision.signalEffect, "want_sleep");
  });

  it("uses the bag price and ignores chat-only fields", () => {
    const decision = decide(signals({ phonePriceCents: 119_900, dueTodayCents: 119_900, budgetCents: 1 }));
    assert.equal(decision.newDeviceCents, 119_900);
    assert.equal(decision.action, "sleep");
  });
});
