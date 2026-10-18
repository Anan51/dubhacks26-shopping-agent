import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUsd } from "./format.js";
import { decide } from "./heuristic.js";
import { phraseDecision, polishPhrase } from "./phrase.js";
import type { Signals } from "./types.js";

function signals(overrides: Partial<Signals> = {}): Signals {
  return {
    deviceAgeMonths: 0,
    condition: "fine",
    problemText: "the battery dies by 3pm",
    problems: ["battery"],
    needVsWant: "unknown",
    urgency: "medium",
    currentPhoneBroken: false,
    reasonText: "",
    owedCents: 42_000,
    budgetCents: 0,
    dueTodayCents: 100_000,
    phonePriceCents: 100_000,
    monthlyPlanCents: 0,
    ...overrides,
  };
}

describe("phraseDecision", () => {
  it("leads with the savings and labels example data", () => {
    const decision = decide(signals());
    const text = phraseDecision(decision, signals(), "keywords");
    assert.match(text, /^Waiting 12 months saves you \$280\./);
    assert.match(text, /You said "the battery dies by 3pm"/);
    assert.match(text, /Need vs want: unknown \(keywords\)/);
    assert.match(text, /Price math decided this/);
    assert.match(text, /example data/);
  });

  it("names the example offer when that is why the call sleeps", () => {
    const shopper = signals({ owedCents: 0, deviceAgeMonths: 24, problemText: "" });
    const decision = decide(shopper);
    const text = phraseDecision(decision, shopper, null);
    assert.match(text, /^Waiting for the example trade-in bundle saves about /);
    assert.match(text, new RegExp(formatUsd(decision.savingsCents).replace(/[$.]/g, "\\$&")));
    assert.match(text, /not a current T-Mobile or carrier deal/);
    assert.ok(decision.savingsCents > 0);
    assert.match(text, /\$186\.67/);
  });

  it("does not mention an example offer when none beats buying now", () => {
    const shopper = signals({ owedCents: 0, deviceAgeMonths: 24, problemText: "" });
    const decision = decide(shopper, [
      {
        id: "example-tiny",
        name: "example tiny promo",
        savingCents: 100,
        monthsFromNow: 2,
        windowLabel: "example window",
      },
    ]);
    const text = phraseDecision(decision, shopper, null);
    assert.equal(decision.offerName, null);
    assert.equal(decision.savingsCents <= 0, true);
    assert.doesNotMatch(text, /example tiny promo/);
    assert.doesNotMatch(text, /saves about \$0/);
    assert.match(text, /^Unlock /);
  });

  it("leads with Unlock when a broken phone is needed now", () => {
    const shopper = signals({
      needVsWant: "need",
      urgency: "high",
      currentPhoneBroken: true,
      problemText: "",
    });
    const decision = decide(shopper);
    const text = phraseDecision(decision, shopper, null);
    assert.match(text, /^Unlock /);
    assert.match(text, /Need vs want: need \(default\)/);
  });
});

describe("polishPhrase", () => {
  it("keeps the template when the rewrite drops the call", async () => {
    const template = "Waiting 12 months saves you $280. Sleep on it?";
    const kept = await polishPhrase(template, "sleep", "test-key", async () => {
      return Response.json({ choices: [{ message: { content: "Buy it today." } }] });
    });
    assert.equal(kept, template);
  });
});
