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
    assert.equal(result.cart?.purchaseScore, 4);
    assert.equal(result.cart?.scoreBucket, "free");
    assert.equal(result.cart?.isUnlocked, false);
    assert.equal(result.cart?.replied, false);
    assert.equal(result.markReplied, true);
    assert.match(result.reply ?? "", /^Buy\./);
    assert.match(result.cart?.explanation ?? "", /Current phone broken: yes \(keywords\)/);
    assert.equal(result.cart?.signalSource, "keywords");
  });

  it("grades unlock and i've decided instead of opening the bag", async () => {
    let stored = cart();
    const unlocked = await applyTurn({
      session: null,
      conversationId: "desk:cart-AB23CD",
      messageId: "m1",
      text: "cart AB23CD unlock",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => stored,
    });
    stored = unlocked.cart ?? stored;
    assert.equal(unlocked.cart?.isUnlocked, false);
    assert.equal(unlocked.markReplied, true);
    assert.match(unlocked.reply ?? "", /^(Buy|Wait|Skip)\./);
    const decided = await applyTurn({
      session: unlocked.session,
      conversationId: "desk:cart-AB23CD",
      messageId: "m2",
      text: "i've decided",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => stored,
    });
    assert.equal(decided.cart?.isUnlocked, false);
    assert.equal(decided.markReplied, true);
    assert.match(decided.reply ?? "", /^(Buy|Wait|Skip)\./);
  });

  it("sleeps on request and does not treat a bare unlock as a grade", async () => {
    let stored = cart();
    const slept = await applyTurn({
      session: null,
      conversationId: "desk:cart-AB23CD",
      messageId: "m1",
      text: "cart AB23CD sleep",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => stored,
    });
    stored = slept.cart ?? stored;
    assert.equal(slept.cart?.isUnlocked, false);
    assert.equal(slept.cart?.status, "locked");
    assert.match(slept.reply ?? "", /^(Buy|Wait|Skip)\./);
    const blocked = await applyTurn({
      session: slept.session,
      conversationId: "desk:cart-AB23CD",
      messageId: "m2",
      text: "unlock",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => stored,
    });
    assert.equal(blocked.cart?.isUnlocked, false);
    assert.equal(blocked.cart?.status, "locked");
  });

  it("tells the shopper how to link when the command is not an id", async () => {
    const result = await applyTurn({
      session: null,
      conversationId: "desk:cart-AB23CD",
      messageId: "m1",
      text: "link my phone",
      now: NOW,
      demoReminderMs: 1_000,
      loadCart: () => cart(),
    });
    assert.equal(result.reply, "link <userId>");
    assert.equal(result.phoneLink, undefined);
  });
});
