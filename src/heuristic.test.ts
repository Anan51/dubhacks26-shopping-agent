import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide, tradeInValueCents } from "./heuristic.js";
import type { Signals } from "./types.js";

const cart = {
  dueTodayCents: 82_800,
  phonePriceCents: 79_900,
  monthlyPlanCents: 7_000,
};

function signals(overrides: Partial<Signals> = {}): Signals {
  return {
    deviceAgeMonths: 14,
    condition: "fine",
    problemText: "it works fine",
    problems: [],
    owedCents: 42_000,
    budgetCents: 150_000,
    ...cart,
    ...overrides,
  };
}

describe("tradeInValueCents", () => {
  it("follows the synthetic curve and lowers the value when the phone is worse", () => {
    assert.equal(tradeInValueCents(0, "fine"), 42_000);
    assert.equal(tradeInValueCents(12, "fine"), 28_000);
    assert.equal(tradeInValueCents(14, "fine"), 26_000);
    assert.equal(tradeInValueCents(18, "fine"), 22_000);
    assert.equal(tradeInValueCents(18, "broken"), 9_900);
    assert.equal(tradeInValueCents(72, "fine"), 1_500);
    assert.ok(tradeInValueCents(80, "fine") === tradeInValueCents(72, "fine"));
    assert.ok(tradeInValueCents(24, "unusable") < tradeInValueCents(24, "broken"));
    assert.ok(tradeInValueCents(24, "broken") < tradeInValueCents(24, "fine"));
  });
});

describe("decide", () => {
  it("waits on a young working phone even when money is still owed", () => {
    const decision = decide(signals());
    assert.equal(decision.action, "wait");
    assert.equal(decision.alternativeId, null);
    assert.deepEqual(decision.reasons, ["young-and-working"]);
    assert.equal(decision.tradeInNowCents, 26_000);
    assert.equal(decision.tradeInLaterCents, 20_000);
    assert.equal(decision.owedLaterCents, 21_000);
    assert.equal(decision.netNowCents, 98_800);
    assert.equal(decision.netLaterCents, 83_800);
    assert.equal(decision.upsideDownCents, 16_000);
  });

  it("buys when an older phone is failing and waiting does not clearly save money", () => {
    const decision = decide(
      signals({
        deviceAgeMonths: 38,
        condition: "broken",
        problemText: "screen is cracked and the battery dies by 3pm",
        owedCents: 0,
        budgetCents: 120_000,
      }),
    );
    assert.equal(decision.action, "buy");
    assert.deepEqual(decision.reasons, ["old-and-failing"]);
    assert.equal(decision.tradeInNowCents, 3_263);
    assert.equal(decision.tradeInLaterCents, 2_250);
    assert.equal(decision.netNowCents, 79_537);
  });

  it("buys a dead phone the shopper can afford", () => {
    const decision = decide(
      signals({
        deviceAgeMonths: 40,
        condition: "unusable",
        problemText: "it won't turn on",
        owedCents: 0,
        budgetCents: 200_000,
      }),
    );
    assert.equal(decision.action, "buy");
    assert.deepEqual(decision.reasons, ["unusable-phone"]);
  });

  it("waits when the cart is over budget, including a dead phone", () => {
    const over = decide(signals({ budgetCents: 1_000 }));
    assert.equal(over.action, "wait");
    assert.deepEqual(over.reasons, ["over-budget"]);

    const dead = decide(
      signals({
        condition: "unusable",
        problemText: "it won't turn on",
        owedCents: 0,
        budgetCents: 1_000,
      }),
    );
    assert.equal(dead.action, "wait");
    assert.deepEqual(dead.reasons, ["over-budget", "unusable-phone"]);
  });

  it("waits when the shopper is upside down on an older phone", () => {
    const decision = decide(
      signals({
        deviceAgeMonths: 30,
        condition: "minor",
        problemText: "scratched",
        owedCents: 40_000,
        budgetCents: 200_000,
      }),
    );
    assert.equal(decision.action, "wait");
    assert.equal(decision.reasons[0], "upside-down");
    assert.ok(decision.upsideDownCents > 10_000);
  });

  it("waits when paying down the balance beats trade-in decay", () => {
    const decision = decide(
      signals({
        deviceAgeMonths: 30,
        condition: "minor",
        problemText: "scratched",
        owedCents: 15_000,
        budgetCents: 200_000,
      }),
    );
    assert.equal(decision.action, "wait");
    assert.deepEqual(decision.reasons, ["waiting-saves-money"]);
    assert.ok(decision.paydownCents - decision.tradeInDecayCents >= 5_000);
  });

  it("waits by default when a working phone is simply old", () => {
    const decision = decide(
      signals({
        deviceAgeMonths: 40,
        condition: "fine",
        problemText: "it works fine",
        owedCents: 0,
        budgetCents: 200_000,
      }),
    );
    assert.equal(decision.action, "wait");
    assert.deepEqual(decision.reasons, ["default-wait"]);
  });

  it("picks a cheaper battery swap when the shopper has a battery problem", () => {
    const decision = decide(
      signals({
        deviceAgeMonths: 38,
        condition: "broken",
        problemText: "my battery dies by 3pm",
        problems: ["battery"],
        owedCents: 0,
        budgetCents: 200_000,
      }),
    );
    assert.equal(decision.action, "better");
    if (decision.action !== "better") {
      return;
    }
    assert.equal(decision.alternativeId, "battery-swap");
    assert.equal(decision.reasons[0], "better-option");
  });

  it("keeps a buy call when the battery swap is not cheaper than the cart", () => {
    const decision = decide(
      signals({
        deviceAgeMonths: 38,
        condition: "broken",
        problemText: "my battery dies by 3pm",
        problems: ["battery"],
        owedCents: 0,
        budgetCents: 200_000,
        dueTodayCents: 5_000,
        phonePriceCents: 5_000,
      }),
    );
    assert.equal(decision.action, "buy");
  });

  it("returns the same call twice", () => {
    const input = signals({ deviceAgeMonths: 38, condition: "broken", owedCents: 0 });
    assert.deepEqual(decide(input), decide(input));
  });
});
