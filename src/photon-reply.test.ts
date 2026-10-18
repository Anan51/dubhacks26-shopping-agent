import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { itemsForBag, startLockedCart } from "./carts.js";
import { createRuntime } from "./runtime.js";
import { createMemoryStore } from "./store.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const SPACE = "pho_spc_00000000000000000000000000";

describe("Photon inbound replies", () => {
  it("asks once, ignores a replayed id, then grades the follow-up", async () => {
    const store = createMemoryStore();
    const cart = startLockedCart({
      items: itemsForBag(["Example phone"], 120_000, true),
      totalCents: 120_000,
      parsedFromPage: true,
      pageHost: "www.apple.com",
      fingerprint: "user-impulsive|120000|example phone",
      now: NOW,
      demo: true,
      lockMs: 600_000,
      userId: "user-impulsive",
      code: "AB23CD",
    });
    cart.necessity = "unnecessary";
    cart.personaId = "impulsive";
    cart.userImpulseScore = 2;
    store.saveCart(cart);
    store.savePhoneLink({
      userId: "user-impulsive",
      conversationId: SPACE,
      agentSenderId: "pho_usr_agent",
      linkedAt: NOW.toISOString(),
    });

    const sent: string[] = [];
    const runtime = createRuntime({
      store,
      now: () => NOW,
      demoReminderMs: 60_000,
      send: async (message) => {
        sent.push(message.text);
      },
      armReminder: () => undefined,
      disarmReminder: () => undefined,
      polish: async (template) => template,
    });

    await runtime.enqueue({
      id: "pho_msg_ask",
      conversationId: SPACE,
      text: "hey",
      agentSenderId: "pho_usr_agent",
    });
    await runtime.enqueue({
      id: "pho_msg_ask",
      conversationId: SPACE,
      text: "hey",
      agentSenderId: "pho_usr_agent",
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /Example phone/);
    assert.match(sent[0] ?? "", /What's making you want to upgrade\?/);

    await runtime.enqueue({
      id: "pho_msg_grade",
      conversationId: SPACE,
      text: "the new color looks nice",
      agentSenderId: "pho_usr_agent",
    });
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0], sent[1]);
    assert.match(sent[1] ?? "", /Purchase score 1/);
    assert.match(sent[1] ?? "", /24 hours/);
    assert.equal(store.getCart("AB23CD")?.scoreBucket, "strict");
  });

  it("sends at most one outbound when the same inbound id is processed twice", async () => {
    const store = createMemoryStore();
    const cart = startLockedCart({
      items: itemsForBag(["Example phone"], 120_000, true),
      totalCents: 120_000,
      parsedFromPage: true,
      pageHost: "www.apple.com",
      fingerprint: "user-impulsive|120000|example phone",
      now: NOW,
      demo: true,
      lockMs: 600_000,
      userId: "user-impulsive",
      code: "CD34EF",
    });
    cart.necessity = "unnecessary";
    cart.userImpulseScore = 2;
    store.saveCart(cart);
    store.savePhoneLink({
      userId: "user-impulsive",
      conversationId: SPACE,
      linkedAt: NOW.toISOString(),
    });
    const sent: string[] = [];
    const runtime = createRuntime({
      store,
      now: () => NOW,
      demoReminderMs: 60_000,
      send: async (message) => {
        sent.push(message.text);
      },
      armReminder: () => undefined,
      disarmReminder: () => undefined,
      polish: async (template) => template,
    });
    const inbound = {
      id: "pho_msg_once",
      conversationId: SPACE,
      text: "the new color looks nice",
      agentSenderId: "pho_usr_agent",
    };
    await Promise.all([runtime.enqueue(inbound), runtime.enqueue(inbound)]);
    assert.equal(sent.length, 1);
    assert.equal(store.hasHandledInbound("pho_msg_once"), true);
  });
});
