import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { itemsForBag, startLockedCart } from "./carts.js";
import { assignAuthUser, cartReadableBy, currentCarts } from "./current-cart.js";
import type { Cart } from "./types.js";

function cart(userId: string, code: string, createdAt: string): Cart {
  const made = startLockedCart({
    items: itemsForBag(["iPhone 16 Pro"], 119_900, true),
    totalCents: 119_900,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: `${userId}|119900|iphone`,
    now: new Date(createdAt),
    demo: true,
    lockMs: 600_000,
    userId,
    code,
  });
  made.createdAt = createdAt;
  return made;
}

describe("current carts", () => {
  it("keeps the newest cart for each user and drops earlier sessions", () => {
    const older = cart("user-local", "AAAAAA", "2026-10-18T00:00:00.000Z");
    const newer = cart("user-local", "BBBBBB", "2026-10-18T01:00:00.000Z");
    const other = cart("user-deliberate", "CCCCCC", "2026-10-18T00:30:00.000Z");
    const listed = currentCarts([older, other, newer]);
    assert.deepEqual(listed.map((item) => item.code), ["BBBBBB", "CCCCCC"]);
    assert.deepEqual(currentCarts([older, newer], "user-local").map((item) => item.code), ["BBBBBB"]);
    assert.deepEqual(currentCarts([older, newer], "user-missing"), []);
  });

  it("hides an owned cart from an unresolved session only when auth is configured", () => {
    const owned = cart("user-local", "AAAAAA", "2026-10-18T00:00:00.000Z");
    assignAuthUser(owned, "account-a");
    const anon = cart("user-anon", "BBBBBB", "2026-10-18T00:00:00.000Z");

    assert.equal(cartReadableBy(owned, "account-a", true), true);
    assert.equal(cartReadableBy(owned, "account-b", true), false);
    assert.equal(cartReadableBy(anon, "account-a", true), false);
    assert.equal(cartReadableBy(owned, null, true), false);
    assert.equal(cartReadableBy(anon, null, true), true);
    assert.equal(cartReadableBy(owned, null, false), true);
    assert.equal(cartReadableBy(owned, "account-b", false), true);
    assert.equal(cartReadableBy(anon, null, false), true);
  });
});
