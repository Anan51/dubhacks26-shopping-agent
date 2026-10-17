import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide } from "./heuristic.js";
import { phraseDecision, polishPhrase } from "./phrase.js";
import type { Signals } from "./types.js";

const signals: Signals = {
  deviceAgeMonths: 14,
  condition: "fine",
  problemText: "it works fine",
  owedCents: 42_000,
  budgetCents: 150_000,
  dueTodayCents: 82_800,
  phonePriceCents: 79_900,
  monthlyPlanCents: 7_000,
};

function geminiReply(text: string): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text }] } }],
  });
}

describe("phraseDecision", () => {
  it("states the call and the cost, trade-in, and financing figures", () => {
    const decision = decide(signals);
    const text = phraseDecision(decision, signals);
    assert.match(text, /^Wait/);
    assert.match(text, /\$988/);
    assert.match(text, /\$260/);
    assert.match(text, /\$200/);
    assert.match(text, /\$420/);
    assert.match(text, /\$210/);
    assert.match(text, /\$35/);
    assert.match(text, /synthetic curve/);
    assert.doesNotMatch(text, /^Buy/);
  });
});

describe("polishPhrase", () => {
  it("returns the template when no key is set and does not call the network", async () => {
    const template = "Wait — hold.";
    let called = false;
    const fetchImpl: typeof fetch = () => {
      called = true;
      throw new Error("network");
    };
    const text = await polishPhrase(template, "wait", undefined, "gemini-2.0-flash", fetchImpl);
    assert.equal(text, template);
    assert.equal(called, false);
  });

  it("returns the template when the model flips the call or the request fails", async () => {
    const template = "Wait — hold.";
    const flipped = await polishPhrase(template, "wait", "test-key", "gemini-2.0-flash", async () => geminiReply("Buy — do it."));
    assert.equal(flipped, template);

    const failed = await polishPhrase(template, "wait", "test-key", "gemini-2.0-flash", async () => {
      throw new Error("offline");
    });
    assert.equal(failed, template);
  });

  it("uses the model text when the call stays the same", async () => {
    const polished = await polishPhrase(
      "Wait — hold.",
      "wait",
      "test-key",
      "gemini-2.0-flash",
      async () => geminiReply("Wait — I'd still hold off. Today you'd lay out $988."),
    );
    assert.match(polished, /^Wait — I'd still hold off/);
  });
});
