import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide } from "./heuristic.js";
import { phraseDecision, polishPhrase } from "./phrase.js";
import type { Signals } from "./types.js";

function signals(overrides: Partial<Signals> = {}): Signals {
  return {
    deviceAgeMonths: 0,
    condition: "fine",
    problemText: "the battery dies by 3pm",
    problems: ["battery"],
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
    assert.match(text, /Parsed with keywords/);
    assert.match(text, /example data/);
  });

  it("leads with Unlock when waiting costs more", () => {
    const decision = decide(signals({ owedCents: 0 }));
    const text = phraseDecision(decision, signals({ owedCents: 0, problemText: "" }), null);
    assert.match(text, /^Unlock /);
    assert.match(text, /example trade-in and financing until you reply/);
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
