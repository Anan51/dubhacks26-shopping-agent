import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_XAI_MODEL, DEFAULT_XAI_TIMEOUT_MS, xaiModelFrom, xaiTimeoutFrom } from "./grok.js";
import { withCartFacts } from "./carts.js";
import { decide } from "./heuristic.js";
import { extractCartCode, extractSignals, parseGrokSignalJson, pickShopperSignals } from "./extract-signals.js";
import type { ConversationContext, Signals } from "./types.js";

function context(step: ConversationContext["step"]): ConversationContext {
  return { step, signals: {}, turns: [] };
}

async function parsed(text: string, step: ConversationContext["step"]) {
  return extractSignals(text, context(step));
}

describe("extractSignals", () => {
  it("reads years, months, and a bare number on the age question", async () => {
    assert.equal((await parsed("2 years", "age")).signals.deviceAgeMonths, 24);
    assert.equal((await parsed("18 months", "age")).signals.deviceAgeMonths, 18);
    assert.equal((await parsed("2", "age")).signals.deviceAgeMonths, 24);
    assert.equal((await parsed("14", "age")).signals.deviceAgeMonths, 14);
    assert.equal((await parsed("purple", "age")).signals.deviceAgeMonths, undefined);
  });

  it("maps free-text condition without deciding buy or wait", async () => {
    assert.equal((await parsed("battery dies by 3pm", "problem")).signals.condition, "broken");
    assert.equal((await parsed("screen is cracked", "problem")).signals.condition, "broken");
    assert.equal((await parsed("it works fine", "problem")).signals.condition, "fine");
    assert.equal((await parsed("a few scratches", "problem")).signals.condition, "minor");
    assert.equal((await parsed("it won't turn on", "problem")).signals.condition, "unusable");
    assert.equal((await parsed("battery dies by 3pm", "problem")).signals.problemText, "battery dies by 3pm");
    assert.deepEqual((await parsed("my battery dies by 3pm", "problem")).signals.problems, ["battery"]);
    assert.equal((await parsed("my battery dies by 3pm", "problem")).source, "keywords");
  });

  it("reads labeled money from any step and bare money only on the matching question", async () => {
    const both = await parsed("I owe $200 and my budget is $500", "need_code");
    assert.equal(both.signals.owedCents, 20_000);
    assert.equal(both.signals.budgetCents, 50_000);
    assert.equal((await parsed("$420", "owed")).signals.owedCents, 42_000);
    assert.equal((await parsed("paid off", "owed")).signals.owedCents, 0);
    assert.equal((await parsed("1500", "budget")).signals.budgetCents, 150_000);
    assert.equal((await parsed("1500", "owed")).signals.budgetCents, undefined);
  });

  it("does not treat a confirmation or a cart total as heuristic inputs", async () => {
    assert.deepEqual((await parsed("YES", "confirm")).signals, {});
    const patch = await parsed("the phone is $799", "age");
    assert.equal(patch.signals.dueTodayCents, undefined);
    assert.equal(patch.signals.phonePriceCents, undefined);
    assert.equal(patch.signals.monthlyPlanCents, undefined);
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

describe("parseGrokSignalJson", () => {
  it("reads a validated payload and rejects invalid JSON", () => {
    assert.deepEqual(parseGrokSignalJson('{"problems":["battery"],"condition":"broken","problemText":"my battery dies by 3pm"}'), {
      problems: ["battery"],
      condition: "broken",
      problemText: "my battery dies by 3pm",
    });
    assert.deepEqual(
      parseGrokSignalJson('Here is the read:\n```json\n{"problems":["battery"],"condition":"broken"}\n```'),
      { problems: ["battery"], condition: "broken" },
    );
    assert.equal(parseGrokSignalJson("not json"), null);
    assert.equal(parseGrokSignalJson('{"condition":"mint"}'), null);
  });

  it("uses Grok when the response is valid and keywords when it is not", async () => {
    let calls = 0;
    const grok = await extractSignals("my battery dies by 3pm", context("problem"), {
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  problems: ["battery"],
                  condition: "broken",
                  problemText: "my battery dies by 3pm",
                }),
              },
            },
          ],
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(grok.source, "grok");
    assert.deepEqual(grok.signals.problems, ["battery"]);

    const fallback = await extractSignals("my battery dies by 3pm", context("problem"), {
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ choices: [{ message: { content: "nope" } }] }),
    });
    assert.equal(fallback.source, "keywords");
    assert.deepEqual(fallback.signals.problems, ["battery"]);

    let network = false;
    const offline = await extractSignals("my battery dies by 3pm", context("problem"), {
      fetchImpl: async () => {
        network = true;
        throw new Error("network");
      },
    });
    assert.equal(network, false);
    assert.equal(offline.source, "keywords");

    const decision = decide(fullSignals(grok.signals));
    assert.equal(decision.action, "unlock");
    assert.equal(decision.waitMonths, 0);
  });
});

function fullSignals(partial: Partial<Signals>): Signals {
  return {
    deviceAgeMonths: partial.deviceAgeMonths ?? 38,
    condition: partial.condition ?? "broken",
    problemText: partial.problemText ?? "my battery dies by 3pm",
    problems: partial.problems ?? ["battery"],
    needVsWant: partial.needVsWant ?? "unknown",
    urgency: partial.urgency ?? "medium",
    currentPhoneBroken: partial.currentPhoneBroken ?? false,
    reasonText: partial.reasonText ?? "",
    owedCents: partial.owedCents ?? 0,
    budgetCents: partial.budgetCents ?? 200_000,
    dueTodayCents: 82_800,
    phonePriceCents: 79_900,
    monthlyPlanCents: 7_000,
  };
}

describe("motive flips", () => {
  it("keywords unlock a needed broken phone and sleep on a low-urgency want", async () => {
    const need = await extractSignals(
      "cracked screen, battery dies by 3pm, I need it for work tomorrow",
      context("confirm"),
    );
    assert.equal(need.source, "keywords");
    assert.equal(need.signals.needVsWant, "need");
    assert.equal(need.signals.urgency, "high");
    assert.equal(need.signals.currentPhoneBroken, true);
    assert.equal(need.motiveSources.needVsWant, "keywords");
    const needed = decide(withCartFacts(need.signals, 120_000));
    assert.equal(needed.mathAction, "sleep");
    assert.equal(needed.action, "unlock");
    assert.equal(needed.signalEffect, "need_unlock");

    const want = await extractSignals("the new color looks nice", context("confirm"));
    assert.equal(want.signals.needVsWant, "want");
    assert.equal(want.signals.urgency, "low");
    assert.equal(want.motiveSources.urgency, "keywords");
    const wanted = decide(withCartFacts({ ...want.signals, owedCents: 0 }, 120_000));
    assert.equal(wanted.mathAction, "unlock");
    assert.equal(wanted.action, "sleep");
    assert.equal(wanted.signalEffect, "want_sleep");
  });

  it("mocked Grok flips both calls, and a bad response falls back to keywords", async () => {
    const needText = "cracked screen, battery dies by 3pm, I need it for work tomorrow";
    const grokNeed = await extractSignals(needText, context("confirm"), {
      apiKey: "test-key",
      fetchImpl: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needVsWant: "need",
                  urgency: "high",
                  currentPhoneBroken: true,
                  reasonText: "needs a working phone for work tomorrow",
                  condition: "broken",
                  problems: ["screen", "battery"],
                }),
              },
            },
          ],
        }),
    });
    assert.equal(grokNeed.source, "grok");
    assert.equal(grokNeed.motiveSources.currentPhoneBroken, "grok");
    assert.equal(decide(withCartFacts(grokNeed.signals, 120_000)).action, "unlock");

    const grokWant = await extractSignals("the new color looks nice", context("confirm"), {
      apiKey: "test-key",
      fetchImpl: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needVsWant: "want",
                  urgency: "low",
                  currentPhoneBroken: false,
                  reasonText: "likes the new color",
                }),
              },
            },
          ],
        }),
    });
    assert.equal(grokWant.motiveSources.needVsWant, "grok");
    const wanted = decide(withCartFacts({ ...grokWant.signals, owedCents: 0 }, 120_000));
    assert.equal(wanted.action, "sleep");
    assert.equal(wanted.signalEffect, "want_sleep");

    const fallback = await extractSignals(needText, context("confirm"), {
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ choices: [{ message: { content: "nope" } }] }),
    });
    assert.equal(fallback.source, "keywords");
    assert.equal(fallback.motiveSources.needVsWant, "keywords");
    assert.equal(decide(withCartFacts(fallback.signals, 120_000)).signalEffect, "need_unlock");
  });
});

describe("Grok defaults", () => {
  it("uses the non-reasoning model and an 8 second timeout unless overridden", () => {
    assert.equal(DEFAULT_XAI_MODEL, "grok-4.20-0309-non-reasoning");
    assert.equal(xaiModelFrom({}), DEFAULT_XAI_MODEL);
    assert.equal(xaiModelFrom({ XAI_MODEL: "grok-4-fast" }), "grok-4-fast");
    assert.equal(DEFAULT_XAI_TIMEOUT_MS, 8_000);
    assert.equal(xaiTimeoutFrom({}), 8_000);
    assert.equal(xaiTimeoutFrom({ XAI_TIMEOUT_MS: "12000" }), 12_000);
  });
});

describe("extractCartCode", () => {
  it("reads a labeled code or a message that is only the code", () => {
    assert.equal(extractCartCode("Hey Simmer, cart k7mq2p"), "K7MQ2P");
    assert.equal(extractCartCode("K7MQ2P"), "K7MQ2P");
    assert.equal(extractCartCode("my code is K7MQ2P somewhere"), undefined);
  });
});
