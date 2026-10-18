import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { itemsForBag, startLockedCart } from "./carts.js";
import { applyTurn } from "./conversation.js";
import type { Cart } from "./types.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");

function cart(): Cart {
  return startLockedCart({
    items: itemsForBag(["iPhone 16 Pro"], 119_900, true),
    totalCents: 119_900,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: "user-demo1|119900|iphone 16 pro",
    now: NOW,
    demo: true,
    lockMs: 600_000,
    userId: "user-demo1",
    code: "AB23CD",
  });
}

describe("applyTurn", () => {
  it("links a phone thread without a survey", async () => {
    const result = await applyTurn({
      session: null,
      conversationId: "desk:cart-AB23CD",
      messageId: "m1",
      text: "link user-demo1",
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: () => cart(),
    });
    assert.equal(result.phoneLink?.userId, "user-demo1");
    assert.equal(result.phoneLink?.conversationId, "desk:cart-AB23CD");
    assert.match(result.reply ?? "", /Linked/);
    assert.equal(result.session.turns.some((turn) => /how old/i.test(turn.text)), false);
  });

  it("verdicts from free text using the bag price", async () => {
    const result = await applyTurn({
      session: null,
      conversationId: "desk:cart-AB23CD",
      messageId: "m1",
      text: "Hey Simmer, cart AB23CD. My battery dies by 3pm and I owe $420.",
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: () => cart(),
    });
    assert.equal(result.cart?.decision?.action, "sleep");
    assert.match(result.reply ?? "", /^Waiting /);
    assert.match(result.reply ?? "", /Current phone broken: yes \(keywords\)/);
    assert.equal(result.cart?.signalSource, "keywords");
  });

  it("unlocks from the chat unless the vault is active", async () => {
    let stored = cart();
    const first = await applyTurn({
      session: null,
      conversationId: "desk:cart-AB23CD",
      messageId: "m1",
      text: "cart AB23CD",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => stored,
    });
    stored = first.cart ?? stored;
    const unlocked = await applyTurn({
      session: first.session,
      conversationId: "desk:cart-AB23CD",
      messageId: "m2",
      text: "unlock",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => stored,
    });
    assert.equal(unlocked.cart?.isUnlocked, true);
    assert.equal(unlocked.cart?.status, "unlocked");

    const slept = await applyTurn({
      session: unlocked.session,
      conversationId: "desk:cart-AB23CD",
      messageId: "m3",
      text: "sleep",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => unlocked.cart ?? stored,
    });
    assert.equal(slept.cart?.status, "vault");
    const blocked = await applyTurn({
      session: slept.session,
      conversationId: "desk:cart-AB23CD",
      messageId: "m4",
      text: "unlock",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => slept.cart ?? stored,
    });
    assert.equal(blocked.cart?.isUnlocked, false);
    assert.match(blocked.reply ?? "", /Vault/);
  });
});
