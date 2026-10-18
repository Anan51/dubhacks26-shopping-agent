import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { GlanceItem } from "../../src/glance.js";
import { awaitingShopperReply, EXAMPLE_NOTE, HELD_LABEL, NECESSARY_LABEL, newestCart, OK_LABEL, OPTIONAL_PAUSE_LABEL, PAUSED_LABEL, plainCartLabel, presentBreakdown, VAULT_LABEL } from "./popup-cart.js";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

describe("popup current bag", () => {
  it("shows only the newest cart for this shopper", () => {
    const carts = [
      bag("cable-a", "shopper", "2026-10-17T12:00:00.000Z"),
      bag("airpods", "shopper", "2026-10-17T18:00:00.000Z"),
      bag("cable-b", "shopper", "2026-10-18T01:00:00.000Z"),
      bag("iphone", "shopper", "2026-10-18T12:00:00.000Z"),
      bag("other", "someone-else", "2026-10-18T13:00:00.000Z"),
    ];
    assert.equal(newestCart(carts, "shopper")?.code, "iphone");
    assert.equal(newestCart(carts, "missing"), null);
    assert.equal(newestCart(carts, ""), null);
    assert.equal(newestCart(carts, "   "), null);
  });

  it("uses plain labels instead of impulse and score wording", () => {
    const asked = item({
      necessity: null,
      status: "locked",
      justificationGrade: null,
      lastPing: { delivered: true },
      purchaseScore: null,
      scoreBucket: null,
    });
    assert.equal(awaitingShopperReply(asked), true);
    assert.equal(plainCartLabel(asked, NOW), PAUSED_LABEL);
    assert.equal(plainCartLabel(item({ necessity: null, purchaseScore: 5, scoreBucket: "free", status: "unlocked" }), NOW), OK_LABEL);
    assert.equal(plainCartLabel(item({ necessity: "necessary", purchaseScore: 5, scoreBucket: "free", status: "unlocked" }), NOW), NECESSARY_LABEL);
    assert.equal(plainCartLabel(item({ necessity: null, status: "unlocked", purchaseScore: null, userImpulseScore: null }), NOW), OK_LABEL);
    assert.equal(PAUSED_LABEL.includes("Impulse"), false);
    assert.equal(OK_LABEL.includes("Score"), false);
  });

  it("does not call a soft pause or a vault a reply wait", () => {
    const soft = item({ necessity: null, status: "locked", scoreBucket: "soft", purchaseScore: 3, userImpulseScore: 2, justificationGrade: 1 });
    const vault = item({ necessity: null, status: "vault", scoreBucket: "strict", purchaseScore: 1, vaultUntil: "2026-10-19T02:00:00.000Z" });
    const undelivered = item({ necessity: null, status: "locked", justificationGrade: null, lastPing: { delivered: false }, scoreBucket: null });
    assert.equal(plainCartLabel(soft, NOW), OPTIONAL_PAUSE_LABEL);
    assert.equal(plainCartLabel(vault, NOW), VAULT_LABEL);
    assert.equal(plainCartLabel(soft, NOW).includes("iMessage"), false);
    assert.equal(plainCartLabel(vault, NOW).includes("iMessage"), false);
    assert.equal(awaitingShopperReply(undelivered), false);
    assert.equal(plainCartLabel(undelivered, NOW).includes("iMessage"), false);
  });

  it("keeps a wait line and shows an example note only when example figures are present", () => {
    const waiting = item({
      necessity: null,
      status: "locked",
      userImpulseScore: null,
      purchaseScore: null,
      scoreBucket: null,
    });
    assert.equal(plainCartLabel(waiting, NOW), HELD_LABEL);
    const detail = presentBreakdown(waiting, NOW);
    assert.equal(detail.exampleNote, EXAMPLE_NOTE);
    const text = detail.lines.map((line) => `${line.label} ${line.value}`).join("\n");
    assert.equal(text.includes("Example data"), false);
    assert.equal(text.includes("carrier quote"), false);
    assert.equal(text.includes("Impulse"), false);
    assert.equal(text.includes("Purchase score"), false);

    const paused = item({ necessity: null, status: "locked", userImpulseScore: 2, purchaseScore: null, decision: null });
    const plain = presentBreakdown(paused, NOW);
    assert.equal(plain.exampleNote, null);
    assert.equal(plain.lines.some((line) => line.value === PAUSED_LABEL), false);
    assert.equal(plain.lines.some((line) => line.value === HELD_LABEL), true);
    assert.equal(plain.lines.some((line) => line.value === OK_LABEL), false);
  });

  it("says a locked bag is paused unless it is free to buy", () => {
    const unlock = item().decision;
    assert.ok(unlock);
    const noDecision = item({ necessity: null, status: "locked", scoreBucket: null, decision: null });
    const unlockDecision = item({
      necessity: null,
      status: "locked",
      scoreBucket: null,
      decision: { ...unlock, action: "unlock", savingsCents: 500 },
    });
    const noSavings = item({
      necessity: null,
      status: "locked",
      scoreBucket: null,
      decision: { ...unlock, action: "sleep", savingsCents: 0 },
    });
    assert.equal(plainCartLabel(noDecision, NOW), HELD_LABEL);
    assert.equal(plainCartLabel(unlockDecision, NOW), HELD_LABEL);
    assert.equal(plainCartLabel(noSavings, NOW), HELD_LABEL);
    assert.equal(plainCartLabel(noDecision, NOW).includes("OK to buy"), false);
    assert.equal(plainCartLabel(item({ necessity: null, status: "unlocked", scoreBucket: null, decision: null }), NOW), OK_LABEL);
    assert.equal(plainCartLabel(item({ necessity: null, status: "locked", scoreBucket: "free", purchaseScore: 5 }), NOW), OK_LABEL);
  });

  it("does not ship the always-on carrier-quote note", () => {
    const html = readFileSync(fileURLToPath(new URL("../popup.html", import.meta.url)), "utf8");
    assert.equal(html.includes("Unlock only re-enables"), false);
    assert.equal(html.includes("not a carrier quote"), false);
  });
});

function bag(code: string, userId: string, createdAt: string): { code: string; userId: string; createdAt: string } {
  return { code, userId, createdAt };
}

function item(overrides: Partial<GlanceItem & { lastPing?: { delivered: boolean } | null }> = {}): GlanceItem & { lastPing?: { delivered: boolean } | null } {
  return {
    code: "AB23CD",
    name: "iPhone 17",
    priceCents: 102_700,
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
    necessity: null,
    userImpulseScore: null,
    purchaseScore: null,
    scoreBucket: null,
    ...overrides,
  };
}
