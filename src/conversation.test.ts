import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCart } from "./carts.js";
import { itemsForIds } from "./catalog.js";
import { applyTurn, type ApplyResult } from "./conversation.js";
import type { Cart, Session } from "./types.js";

const NOW = new Date("2026-10-17T20:00:00.000Z");

function sampleCart(code: string, demo = true): Cart {
  const items = itemsForIds(["phone-n1-128", "plan-unlimited", "acc-case"]);
  if (!items) {
    throw new Error("catalog missing");
  }
  return createCart({
    items,
    now: NOW,
    demo,
    coolingMs: 600_000,
    lockThresholdCents: 10_000,
    guardEnabled: true,
    lock: true,
    code,
  });
}

function run(cart: Cart, lines: string[]): { cart: Cart; results: ApplyResult[] } {
  let current = cart;
  let session: Session | null = null;
  const results: ApplyResult[] = [];
  for (const [index, text] of lines.entries()) {
    const result = applyTurn({
      session,
      conversationId: "desk:test",
      messageId: `m-${index}`,
      text,
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: (code) => (current.code === code ? current : undefined),
    });
    session = result.session;
    if (result.cart) {
      current = result.cart;
    }
    results.push(result);
  }
  return { cart: current, results };
}

describe("applyTurn", () => {
  it("asks for the missing facts, then waits and schedules a reminder", () => {
    const code = "K7MQ2P";
    const { cart, results } = run(sampleCart(code), [
      `Hey WaitMate, cart ${code}`,
      "14 months",
      "it works fine",
      "420",
      "1500",
    ]);
    assert.equal(results[0]?.reply?.includes("How old"), true);
    assert.equal(results[1]?.reply?.includes("What's wrong"), true);
    assert.equal(results[2]?.reply?.includes("still owe"), true);
    assert.equal(results[3]?.reply?.includes("out of pocket"), true);
    const last = results[4];
    assert.equal(cart.status, "saved");
    assert.equal(cart.decision?.action, "wait");
    assert.equal(last?.armReminder, true);
    assert.match(last?.reply ?? "", /Wait/);
    assert.match(last?.reply ?? "", /\$988/);
    assert.match(last?.reply ?? "", /Demo mode/);
    assert.equal(cart.reminderFireAt, new Date(NOW.getTime() + 60_000).toISOString());
    assert.ok(cart.reminderAt && cart.reminderAt > cart.reminderFireAt);
  });

  it("asks for a yes before unlocking a buy", () => {
    const code = "M4N8Q2";
    const { cart, results } = run(sampleCart(code), [
      `Hey WaitMate, cart ${code}`,
      "38 months",
      "screen is cracked and the battery dies by 3pm",
      "0",
      "1200",
      "YES",
    ]);
    assert.match(results[4]?.reply ?? "", /^Buy/);
    assert.equal(results[4]?.cart?.status, "cooling");
    assert.equal(cart.status, "completed");
    assert.equal(cart.orderId, "WM-M4N8");
    assert.equal(results[5]?.disarmReminder, true);
  });

  it("lets the shopper buy after a wait, or save after a buy recommendation", () => {
    const waited = run(sampleCart("W8TM22"), [
      "Hey WaitMate, cart W8TM22",
      "14 months",
      "it works fine",
      "0",
      "2000",
      "BUY",
    ]);
    assert.equal(waited.cart.status, "completed");

    const saved = run(sampleCart("B8YM22"), [
      "Hey WaitMate, cart B8YM22",
      "38 months",
      "screen is cracked",
      "0",
      "1200",
      "WAIT",
    ]);
    assert.equal(saved.cart.status, "saved");
    assert.equal(saved.results.at(-1)?.armReminder, true);
  });

  it("fills every shopper signal from one message, then still asks before a buy", () => {
    const { cart, results } = run(sampleCart("PNE234"), [
      "Hey WaitMate, cart PNE234. My phone is 3 years old, the screen is cracked, I owe $0, and my budget is $1200.",
    ]);
    assert.equal(results.length, 1);
    assert.equal(cart.decision?.action, "buy");
    assert.equal(cart.status, "cooling");
    assert.match(results[0]?.reply ?? "", /Reply YES/);
  });

  it("asks again when the age is not a number, and rejects an unknown cart", () => {
    const again = run(sampleCart("AGE234"), ["Hey WaitMate, cart AGE234", "purple"]);
    assert.match(again.results[1]?.reply ?? "", /I need an age/);
    assert.equal(again.cart.decision, null);

    const missing = run(sampleCart("REAL22"), ["Hey WaitMate, cart ZZZZZZ"]);
    assert.match(missing.results[0]?.reply ?? "", /can't find cart ZZZZZZ/);
    assert.equal(missing.cart.code, "REAL22");
    assert.equal(missing.cart.status, "cooling");
  });

  it("starts the questions over when the shopper names a different cart", () => {
    const first = sampleCart("FRST22");
    const second = sampleCart("SCND22");
    const carts = new Map<string, Cart>([
      [first.code, first],
      [second.code, second],
    ]);
    let session: Session | null = null;
    for (const [index, text] of ["Hey WaitMate, cart FRST22", "14 months", "it works fine", "0", "2000"].entries()) {
      const result = applyTurn({
        session,
        conversationId: "desk:test",
        messageId: `a-${index}`,
        text,
        now: NOW,
        demoReminderMs: 60_000,
        loadCart: (code) => carts.get(code),
      });
      session = result.session;
      if (result.cart) {
        carts.set(result.cart.code, result.cart);
      }
    }
    assert.equal(carts.get("FRST22")?.status, "saved");

    const switched = applyTurn({
      session,
      conversationId: "desk:test",
      messageId: "b-0",
      text: "Hey WaitMate, cart SCND22",
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: (code) => carts.get(code),
    });
    assert.match(switched.reply ?? "", /How old/);
    assert.equal(switched.cart?.code, "SCND22");
    assert.equal(switched.cart?.status, "cooling");
    assert.equal(switched.cart?.decision, null);
    assert.equal(carts.get("FRST22")?.status, "saved");
  });

  it("ignores a replay of the same inbound id", () => {
    const cart = sampleCart("DUP222");
    const first = applyTurn({
      session: null,
      conversationId: "desk:test",
      messageId: "same",
      text: "hello",
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: () => cart,
    });
    const second = applyTurn({
      session: first.session,
      conversationId: "desk:test",
      messageId: "same",
      text: "hello again",
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: () => cart,
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.reply, null);
    assert.equal(second.session.turns.length, first.session.turns.length);
  });
});
