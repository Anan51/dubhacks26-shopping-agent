import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide } from "../heuristic.js";
import { withCartFacts } from "../carts.js";
import { annotateDecision } from "./cartReading.js";
import { EMPTY_IMPULSE_SIGNALS, regretSearchMaxDistance, scoreFromSignals, type ImpulseItem, type ImpulseSignals } from "./backboardScore.js";
import { clampImpulseScale, formatImpulseScore, impulseBand, legacyImpulseBase } from "./lockBand.js";

const phone: ImpulseItem = { item: "Example phone", category: "phone", price: 40, necessary: false };

function signals(patch: Partial<ImpulseSignals> = {}): ImpulseSignals {
  return { ...EMPTY_IMPULSE_SIGNALS, goals: [], ...patch };
}

describe("impulse signals", () => {
  it("starts a shopper with no history at 4.5 and says nothing", () => {
    const scored = scoreFromSignals(phone, signals());
    assert.equal(scored.score, 4.5);
    assert.equal(scored.why, null);
    assert.deepEqual(scoreFromSignals(phone, signals({ goals: [] })), scored);
  });

  it("ignores history when the item is necessary", () => {
    const scored = scoreFromSignals(
      { ...phone, necessary: true, hours: 20 },
      signals({
        categoryRegrets: 4,
        regretCount: 4,
        ratedCount: 4,
        weeklyBudget: 1,
        goals: [{ text: "Trip", targetAmount: 10, createdAt: "2026-01-01T00:00:00.000Z" }],
      }),
    );
    assert.equal(scored.score, 4.5);
    assert.equal(scored.why, null);
  });

  it("scores regret history stricter than a clean slate on the same unnecessary bag", () => {
    const clean = scoreFromSignals(phone, signals());
    const regretted = scoreFromSignals(phone, signals({ categoryRegrets: 1 }));
    assert.equal(clean.score, 4.5);
    assert.equal(clean.why, null);
    assert.equal(regretted.score, 5.2);
    assert.ok(regretted.score > clean.score);
    assert.equal(regretted.why, "You regretted a similar purchase before.");
  });

  it("does not free the score for kept purchases", () => {
    const kept = scoreFromSignals(phone, signals({ categoryKept: 2 }));
    assert.equal(kept.score, 4.5);
    assert.equal(kept.why, null);
    const many = scoreFromSignals(phone, signals({ categoryKept: 5, regretCount: 0, ratedCount: 5 }));
    assert.equal(many.score, 4.5);
    assert.equal(impulseBand(many.score), "soft");
  });

  it("nudges up with the overall regret ratio and does not nudge down", () => {
    const high = scoreFromSignals(phone, signals({ regretCount: 4, ratedCount: 4 }));
    assert.equal(high.score, 4.9);
    assert.equal(high.why, "More of your past buys were regrets.");

    const low = scoreFromSignals(phone, signals({ regretCount: 0, ratedCount: 4 }));
    assert.equal(low.score, 4.5);
    assert.equal(low.why, null);
    const minority = scoreFromSignals(phone, signals({ regretCount: 1, ratedCount: 4 }));
    assert.equal(minority.score, 4.5);
    assert.equal(minority.why, null);
  });

  it("nudges up softly when the price is over the weekly budget", () => {
    const over = scoreFromSignals({ ...phone, price: 80 }, signals({ weeklyBudget: 50 }));
    assert.equal(over.score, 5);
    assert.equal(over.why, "This costs more than your weekly budget.");
    const under = scoreFromSignals({ ...phone, price: 50 }, signals({ weeklyBudget: 50 }));
    assert.equal(under.score, 4.5);
    assert.equal(under.why, null);
    const missing = scoreFromSignals({ ...phone, price: 500 }, signals({ weeklyBudget: null }));
    assert.equal(missing.score, 4.5);
  });

  it("uses hours over 8 as a soft upward signal", () => {
    const hidden = scoreFromSignals({ ...phone, hours: 8 }, signals());
    assert.equal(hidden.score, 4.5);
    assert.equal(hidden.why, null);
    const shown = scoreFromSignals({ ...phone, hours: 8.1 }, signals());
    assert.equal(shown.score, 4.9);
    assert.equal(shown.why, "This is more than a day's work.");
    const absent = scoreFromSignals({ ...phone, hours: null }, signals());
    assert.equal(absent.score, 4.5);
  });

  it("does not penalize an empty goal list, and does not free a buy that lines up with a goal", () => {
    const none = scoreFromSignals(phone, signals({ goals: [] }));
    assert.equal(none.score, 4.5);
    const untitled = scoreFromSignals(phone, signals({ goals: [{ text: "Save more", targetAmount: null, createdAt: "" }] }));
    assert.equal(untitled.score, 4.5);
    assert.equal(untitled.why, null);
    const aligned = scoreFromSignals(
      phone,
      signals({ goals: [{ text: "Example phone", targetAmount: 1_000, createdAt: "" }] }),
    );
    assert.equal(aligned.score, none.score);
    assert.equal(aligned.why, null);
    const competing = scoreFromSignals(
      { ...phone, price: 80 },
      signals({ goals: [{ text: "Trip", targetAmount: 100, createdAt: "" }] }),
    );
    assert.equal(competing.score, 4.8);
    assert.ok(competing.score > none.score);
    assert.equal(competing.why, "This takes a bite out of a goal you saved.");
  });

  it("clamps to 1..8", () => {
    assert.equal(clampImpulseScale(0), 1);
    assert.equal(clampImpulseScale(99), 8);
    const topped = scoreFromSignals(
      { ...phone, price: 500, hours: 40 },
      signals({
        categoryRegrets: 6,
        regretCount: 6,
        ratedCount: 6,
        weeklyBudget: 10,
        goals: [{ text: "Trip", targetAmount: 20, createdAt: "" }],
      }),
    );
    assert.equal(topped.score, 8);
    assert.ok(topped.score >= 1 && topped.score <= 8);
  });
});

describe("regret search distance", () => {
  it("defaults to 0.7 and rejects values outside 0..1", () => {
    assert.equal(regretSearchMaxDistance({}), 0.7);
    assert.equal(regretSearchMaxDistance({ REGRET_SEARCH_MAX_DISTANCE: "" }), 0.7);
    assert.equal(regretSearchMaxDistance({ REGRET_SEARCH_MAX_DISTANCE: "0.578" }), 0.578);
    assert.equal(regretSearchMaxDistance({ REGRET_SEARCH_MAX_DISTANCE: "0" }), 0);
    assert.equal(regretSearchMaxDistance({ REGRET_SEARCH_MAX_DISTANCE: "1" }), 1);
    assert.equal(regretSearchMaxDistance({ REGRET_SEARCH_MAX_DISTANCE: "1.2" }), 0.7);
    assert.equal(regretSearchMaxDistance({ REGRET_SEARCH_MAX_DISTANCE: "-0.1" }), 0.7);
    assert.equal(regretSearchMaxDistance({ REGRET_SEARCH_MAX_DISTANCE: "nope" }), 0.7);
  });
});

describe("1-8 lock bands", () => {
  it("maps deliberate, middle, and impulsive scores onto free, soft, and strict", () => {
    for (const score of [1, 2, 3]) {
      assert.equal(impulseBand(score), "free");
      assert.equal(legacyImpulseBase(score), 4);
    }
    for (const score of [3.1, 4, 4.5, 5]) {
      assert.equal(impulseBand(score), "soft");
      assert.equal(legacyImpulseBase(score), 2);
    }
    for (const score of [5.1, 6, 7, 8]) {
      assert.equal(impulseBand(score), "strict");
      assert.equal(legacyImpulseBase(score), 1);
    }
    assert.equal(formatImpulseScore(4.5), "4.5");
    assert.equal(formatImpulseScore(8), "8");
  });

  it("returns the same decision object decide() produced", () => {
    const decision = decide(withCartFacts({}, 120_000));
    const annotated = annotateDecision(decision, {
      impulse: { score1to8: 4.5, band: "soft", why: null },
      hoursOfWork: null,
      hoursOfWorkText: null,
      legacyImpulse: 2,
    });
    assert.equal(annotated.decision, decision);
    assert.equal(annotated.impulse.score1to8, 4.5);
    assert.equal(annotated.hoursOfWork, null);
  });
});
