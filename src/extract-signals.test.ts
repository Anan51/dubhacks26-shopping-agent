import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractCartCode, extractSignals, pickShopperSignals } from "./extract-signals.js";
import type { ConversationContext } from "./types.js";

function context(step: ConversationContext["step"]): ConversationContext {
  return { step, signals: {}, turns: [] };
}

describe("extractSignals", () => {
  it("reads years, months, and a bare number on the age question", () => {
    assert.equal(extractSignals("2 years", context("age")).deviceAgeMonths, 24);
    assert.equal(extractSignals("18 months", context("age")).deviceAgeMonths, 18);
    assert.equal(extractSignals("2", context("age")).deviceAgeMonths, 24);
    assert.equal(extractSignals("14", context("age")).deviceAgeMonths, 14);
    assert.equal(extractSignals("purple", context("age")).deviceAgeMonths, undefined);
  });

  it("maps free-text condition without deciding buy or wait", () => {
    assert.equal(extractSignals("battery dies by 3pm", context("problem")).condition, "broken");
    assert.equal(extractSignals("screen is cracked", context("problem")).condition, "broken");
    assert.equal(extractSignals("it works fine", context("problem")).condition, "fine");
    assert.equal(extractSignals("a few scratches", context("problem")).condition, "minor");
    assert.equal(extractSignals("it won't turn on", context("problem")).condition, "unusable");
    assert.equal(extractSignals("battery dies by 3pm", context("problem")).problemText, "battery dies by 3pm");
  });

  it("reads labeled money from any step and bare money only on the matching question", () => {
    const both = extractSignals("I owe $200 and my budget is $500", context("need_code"));
    assert.equal(both.owedCents, 20_000);
    assert.equal(both.budgetCents, 50_000);
    assert.equal(extractSignals("$420", context("owed")).owedCents, 42_000);
    assert.equal(extractSignals("paid off", context("owed")).owedCents, 0);
    assert.equal(extractSignals("1500", context("budget")).budgetCents, 150_000);
    assert.equal(extractSignals("1500", context("owed")).budgetCents, undefined);
  });

  it("does not treat a confirmation or a cart total as heuristic inputs", () => {
    assert.deepEqual(extractSignals("YES", context("confirm")), {});
    const patch = extractSignals("the phone is $799", context("age"));
    assert.equal(patch.dueTodayCents, undefined);
    assert.equal(patch.phonePriceCents, undefined);
    assert.equal(patch.monthlyPlanCents, undefined);
  });

  it("drops cart prices if a caller hands them back", () => {
    const picked = pickShopperSignals({
      deviceAgeMonths: 12,
      dueTodayCents: 1,
      phonePriceCents: 2,
      monthlyPlanCents: 3,
    });
    assert.deepEqual(picked, { deviceAgeMonths: 12 });
  });
});

describe("extractCartCode", () => {
  it("reads a labeled code or a message that is only the code", () => {
    assert.equal(extractCartCode("Hey WaitMate, cart k7mq2p"), "K7MQ2P");
    assert.equal(extractCartCode("K7MQ2P"), "K7MQ2P");
    assert.equal(extractCartCode("my code is K7MQ2P somewhere"), undefined);
  });
});
