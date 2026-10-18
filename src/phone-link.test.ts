import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { itemsForBag, startLockedCart } from "./carts.js";
import { notifyCheckout, parseLinkCommand } from "./phone-link.js";
import { createMemoryStore, type PhoneLink } from "./store.js";
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
    demo: false,
    lockMs: 600_000,
    userId: "user-demo1",
    code: "AB23CD",
  });
}

describe("phone link", () => {
  it("reads a one-time link command", () => {
    assert.deepEqual(parseLinkCommand("link user-demo1"), { userId: "user-demo1" });
    assert.deepEqual(parseLinkCommand("LINK"), { userId: null });
    assert.equal(parseLinkCommand("link my phone please"), null);
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
    assert.match(sent, /paused your \$1,199 checkout/);
    assert.match(sent, /What's making you want to upgrade\?/);
    assert.match(sent, /AB23CD/);

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
});
