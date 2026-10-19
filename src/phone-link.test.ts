import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyTurn } from "./conversation.js";
import { itemsForBag, startLockedCart } from "./carts.js";
import { linkCodeForUser, linkPhoneText, pausedLinkLine } from "./links.js";
import { justificationAsk, notifyCheckout, parseLinkCommand } from "./phone-link.js";
import { createMemoryStore, type PhoneLink } from "./store.js";
import type { Cart, CartItem } from "./types.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");

function cart(): Cart {
  return startLockedCart({
    items: itemsForBag(["iPhone 16 Pro"], 119_900, true),
    totalCents: 119_900,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: "user-demo1|119900|iphone 16 pro",
    now: NOW,
    demo: false,
    lockMs: 600_000,
    userId: "user-demo1",
    code: "AB23CD",
  });
}

const SHOPPER = "user-2557c60f-1111-4111-8111-111111111111";
const PLACEHOLDER_NUMBER = "+15550001111";

describe("phone link", () => {
  it("reads a one-time link command", () => {
    assert.deepEqual(parseLinkCommand("link user-demo1"), { userId: "user-demo1", code: null });
    assert.deepEqual(parseLinkCommand("LINK"), { userId: null, code: null });
    assert.equal(parseLinkCommand("link my phone please"), null);
  });

  it("resolves a short code and the old full id to the same shopper", async () => {
    const store = createMemoryStore();
    const code = store.rememberLinkCode(SHOPPER);
    assert.equal(code, linkCodeForUser(SHOPPER));
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(linkPhoneText(SHOPPER), `link ${code}`);

    const fromShort = await applyTurn({
      session: null,
      conversationId: "desk:shortlink1",
      messageId: "m-short",
      text: `link ${code.toLowerCase()}`,
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: () => cart(),
      resolveLinkCode: (token) => store.userIdForLinkCode(token) ?? null,
    });
    assert.equal(fromShort.phoneLink?.userId, SHOPPER);
    assert.equal(fromShort.phoneLink?.conversationId, "desk:shortlink1");

    const fromFull = await applyTurn({
      session: null,
      conversationId: "desk:fulllink01",
      messageId: "m-full",
      text: `link ${SHOPPER}`,
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: () => cart(),
      resolveLinkCode: (token) => store.userIdForLinkCode(token) ?? null,
    });
    assert.equal(fromFull.phoneLink?.userId, SHOPPER);
    assert.equal(fromFull.phoneLink?.conversationId, "desk:fulllink01");

    const unknown = await applyTurn({
      session: null,
      conversationId: "desk:unknown01",
      messageId: "m-unknown",
      text: "link ZZZZZZ",
      now: NOW,
      demoReminderMs: 60_000,
      loadCart: () => cart(),
      resolveLinkCode: () => null,
    });
    assert.equal(unknown.phoneLink, undefined);
    assert.equal(unknown.reply, "link <userId>");
  });

  it("names the agent number and a short code, and hides a raw user id", () => {
    const code = linkCodeForUser(SHOPPER);
    const linked = pausedLinkLine(`link ${code}`, PLACEHOLDER_NUMBER);
    assert.equal(linked, `Text link ${code} to ${PLACEHOLDER_NUMBER}.`);
    assert.equal(linked.includes(SHOPPER), false);
    assert.equal(linked.includes("iMessage number"), false);

    const noNumber = pausedLinkLine(`link ${code}`, null);
    assert.equal(noNumber, `Text link ${code} to Simmer on iMessage.`);
    assert.equal(noNumber.includes(SHOPPER), false);

    const raw = pausedLinkLine(`link ${SHOPPER}`, null);
    assert.equal(raw, "Text Simmer on iMessage to link this checkout.");
    assert.equal(raw.includes("user-"), false);

    const numberedRaw = pausedLinkLine(`link ${SHOPPER}`, PLACEHOLDER_NUMBER);
    assert.equal(numberedRaw, `Text Simmer at ${PLACEHOLDER_NUMBER} to link this checkout.`);
    assert.equal(numberedRaw.includes(SHOPPER), false);
  });

  it("pings a stored thread and falls back to sms plus a QR code", async () => {
    const store = createMemoryStore();
    const unlinked = await notifyCheckout({
      store,
      cart: cart(),
      agentHandle: "+15550001111",
      fail: false,
      now: NOW,
      send: async () => {
        throw new Error("should not send");
      },
      qr: async (text) => `qr:${text}`,
    });
    assert.equal(unlinked.delivered, false);
    assert.equal(unlinked.reason, "unlinked");
    assert.match(unlinked.smsLink ?? "", /^sms:\+15550001111&body=/);
    assert.match(unlinked.qrDataUrl ?? "", /^qr:sms:/);
    assert.match(unlinked.prefilled, /AB23CD/);

    const link: PhoneLink = {
      userId: "user-demo1",
      conversationId: "desk:cart-AB23CD",
      linkedAt: NOW.toISOString(),
    };
    store.savePhoneLink(link);
    let sent = "";
    const delivered = await notifyCheckout({
      store,
      cart: cart(),
      agentHandle: "+15550001111",
      fail: false,
      now: NOW,
      send: async (_link, text) => {
        sent = text;
      },
      qr: async () => "unused",
    });
    assert.equal(delivered.delivered, true);
    assert.equal(
      sent,
      "Simmer paused your iPhone 16 Pro ($1,199) checkout. Cart AB23CD. What's making you want to upgrade?",
    );

    const failed = await notifyCheckout({
      store,
      cart: cart(),
      agentHandle: "+15550001111",
      fail: false,
      now: NOW,
      send: async () => {
        throw new Error("photon down");
      },
      qr: async (text) => `qr:${text}`,
    });
    assert.equal(failed.delivered, false);
    assert.equal(failed.reason, "send_failed");
    assert.ok(failed.qrDataUrl);
  });

  it("names one item and the bag total, with no more-count", () => {
    assert.equal(
      justificationAsk(bag(["iPhone 16 Pro"], 119_900)),
      "iPhone 16 Pro ($1,199) is marinating. What's making you want to upgrade?",
    );
    assert.equal(
      justificationAsk(bag(["USB-C Charge Cable"], 1_999)),
      "USB-C Charge Cable ($19.99) is marinating. What's making you want to upgrade?",
    );
  });

  it("names the main item and counts the rest, including titles the card leaves off", () => {
    const caseFirst = bag(["iPhone 16 case", "iPhone 16"], 82_800);
    assert.equal(
      justificationAsk(caseFirst),
      "iPhone 16 +1 more ($828) is marinating. What's making you want to upgrade?",
    );

    const priced = bag([], 81_800, [
      line("USB-C Charge Cable", 1_900),
      line("iPhone 16", 79_900),
    ]);
    assert.equal(
      justificationAsk(priced),
      "iPhone 16 +1 more ($818) is marinating. What's making you want to upgrade?",
    );

    const priceyCase = bag([], 82_800, [
      line("iPhone 16 case", 2_900),
      line("iPhone 16", 79_900),
    ]);
    assert.equal(
      justificationAsk(priceyCase),
      "iPhone 16 +1 more ($828) is marinating. What's making you want to upgrade?",
    );

    const tied = bag([], 100_000, [
      line("iPhone 16", 50_000),
      line("iPhone 17", 50_000),
    ]);
    assert.equal(
      justificationAsk(tied),
      "iPhone 16 +1 more ($1,000) is marinating. What's making you want to upgrade?",
    );

    const many = bag(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"], 6_000);
    assert.equal(
      justificationAsk(many),
      "Alpha +5 more ($60) is marinating. What's making you want to upgrade?",
    );

    const hidden = Object.assign(bag(["Alpha", "Bravo"], 5_000), { hiddenItemCount: 3 });
    assert.equal(
      justificationAsk(hidden),
      "Alpha +4 more ($50) is marinating. What's making you want to upgrade?",
    );

    const repeated = bag(["iPhone 16", "  iPhone 16  ", "USB-C Charge Cable"], 10_000);
    assert.equal(
      justificationAsk(repeated),
      "iPhone 16 +1 more ($100) is marinating. What's making you want to upgrade?",
    );
  });

  it("ignores a blank title and falls back when the bag has no name", () => {
    const blank = bag([], 60_000, [line("   ", 50_000), line("iPhone 16", 10_000)]);
    assert.equal(
      justificationAsk(blank),
      "iPhone 16 ($600) is marinating. What's making you want to upgrade?",
    );
    assert.equal(
      justificationAsk(bag([], 0, [])),
      "Your bag ($0) is marinating. What's making you want to upgrade?",
    );
  });
});

function bag(names: readonly string[], totalCents: number, items?: CartItem[]): Cart {
  return startLockedCart({
    items: items ?? itemsForBag(names, totalCents, true),
    totalCents,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: "user-demo1|bag",
    now: NOW,
    demo: false,
    lockMs: 600_000,
    userId: "user-demo1",
    code: "AB23CD",
  });
}

function line(name: string, priceCents: number): CartItem {
  return {
    id: name.trim().toLowerCase().replace(/\s+/g, "-") || "blank",
    kind: "accessory",
    name,
    detail: "Read from the Apple bag",
    priceCents,
    cadence: "once",
  };
}
