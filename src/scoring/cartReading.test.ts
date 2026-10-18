import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { itemsForBag, startLockedCart } from "../carts.js";
import type { Cart } from "../types.js";
import { applyImpulseReading, type CartReading } from "./cartReading.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const LATER = new Date("2026-10-19T00:00:00.000Z");

function bag(): Cart {
  const cart = startLockedCart({
    items: itemsForBag(["Example phone"], 120_000, true),
    totalCents: 120_000,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: "user-low|120000|example phone",
    now: NOW,
    demo: true,
    lockMs: 600_000,
    userId: "user-low",
    code: "LOWBAG",
  });
  cart.necessity = "unnecessary";
  return cart;
}

function reading(score: number, band: "free" | "soft" | "strict"): CartReading {
  const legacyImpulse = band === "free" ? 4 : band === "soft" ? 2 : 1;
  return {
    impulse: { score1to8: score, band, why: null },
    hoursOfWork: { hours: 10, hourlyRate: 20 },
    hoursOfWorkText: "This is about 10 hours of work at $20/hr.",
    legacyImpulse,
  };
}

describe("impulse lock", () => {
  it("leaves an unnecessary bag locked when the score is 3 or lower", () => {
    const cart = bag();
    applyImpulseReading(cart, reading(3, "free"), NOW, 60_000, "create");
    assert.equal(cart.impulse?.score1to8, 3);
    assert.equal(cart.impulse?.band, "free");
    assert.equal(cart.hoursOfWork?.hours, 10);
    assert.equal(cart.isUnlocked, false);
    assert.equal(cart.status, "locked");
    assert.equal(cart.vaultUntil, null);
  });

  it("does not re-sleep a strict bag or unlock a free one when the same bag is posted again", () => {
    const cart = bag();
    applyImpulseReading(cart, reading(7, "strict"), NOW, 60_000, "create");
    const until = cart.vaultUntil;
    cart.reminderSentAt = "2026-10-18T00:01:00.000Z";
    assert.equal(cart.status, "vault");

    applyImpulseReading(cart, reading(7.4, "strict"), LATER, 60_000, "refresh");
    assert.equal(cart.vaultUntil, until);
    assert.equal(cart.reminderSentAt, "2026-10-18T00:01:00.000Z");
    assert.equal(cart.impulse?.score1to8, 7.4);
    assert.equal(cart.status, "vault");

    applyImpulseReading(cart, reading(2, "free"), LATER, 60_000, "refresh");
    assert.equal(cart.isUnlocked, false);
    assert.equal(cart.status, "vault");
    assert.equal(cart.vaultUntil, until);
    assert.equal(cart.impulse?.band, "free");
  });
});
