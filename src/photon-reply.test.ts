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
    assert.match(sent[0] ?? "", /^(Buy|Wait|Skip)\./);
    assert.equal(store.getCart("AB23CD")?.isUnlocked, false);

    await runtime.enqueue({
      id: "pho_msg_grade",
      conversationId: SPACE,
      text: "the new color looks nice",
      agentSenderId: "pho_usr_agent",
    });
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0], sent[1]);
    assert.match(sent[1] ?? "", /^(Buy|Wait|Skip)\./);
    assert.equal(store.getCart("AB23CD")?.scoreBucket, "strict");
    assert.equal(store.getCart("AB23CD")?.replied, true);
    assert.equal(store.getCart("AB23CD")?.isUnlocked, false);
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

  it("does not mark replied when the Photon send throws, and a retry can succeed", async () => {
    const store = linkedStore("EF56GH");
    let attempts = 0;
    let repliedDuringSend: boolean | null = null;
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((part) => String(part)).join(" "));
    };
    const runtime = createRuntime({
      store,
      now: () => NOW,
      demoReminderMs: 60_000,
      send: async () => {
        attempts += 1;
        repliedDuringSend = store.getCart("EF56GH")?.replied === true;
        if (attempts === 1) {
          throw new Error("photon down bearer super-secret-token");
        }
      },
      armReminder: () => undefined,
      disarmReminder: () => undefined,
      polish: async (template) => template,
    });
    const inbound = {
      id: "pho_msg_save_first",
      conversationId: SPACE,
      text: "cracked screen, battery dies by 3pm, I need it for work tomorrow",
    };
    try {
      await assert.rejects(runtime.enqueue(inbound), /iMessage send failed/);
    } finally {
      console.error = original;
    }
    const saved = store.getCart("EF56GH");
    assert.equal(repliedDuringSend, false);
    assert.equal(saved?.replied, false);
    assert.equal(saved?.isUnlocked, false);
    assert.equal(saved?.status, "locked");
    assert.match(saved?.advice ?? "", /^Buy\./);
    assert.equal(store.getSession(SPACE)?.turns.length ?? 0, 0);
    assert.equal(store.hasHandledInbound("pho_msg_save_first"), false);
    const logText = logged.join("\n");
    assert.match(logText, /iMessage send failed/);
    assert.equal(logText.includes("super-secret-token"), false);
    assert.equal(logText.includes("cracked screen"), false);

    await runtime.enqueue(inbound);
    const retried = store.getCart("EF56GH");
    const turns = store.getSession(SPACE)?.turns ?? [];
    assert.equal(attempts, 2);
    assert.equal(retried?.replied, true);
    assert.equal(retried?.isUnlocked, false);
    assert.equal(retried?.status, "locked");
    assert.match(retried?.advice ?? "", /^Buy\./);
    assert.equal(turns.filter((turn) => turn.role === "shopper").length, 1);
    assert.equal(turns.filter((turn) => turn.role === "agent").length, 1);
  });

  it("does not mark replied when the send returns failure, and a retry can succeed", async () => {
    const store = linkedStore("GH78JK");
    let attempts = 0;
    const runtime = createRuntime({
      store,
      now: () => NOW,
      demoReminderMs: 60_000,
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false };
        }
      },
      armReminder: () => undefined,
      disarmReminder: () => undefined,
      polish: async (template) => template,
    });
    const inbound = {
      id: "pho_msg_fail_result",
      conversationId: SPACE,
      text: "the new color looks nice",
    };
    await assert.rejects(runtime.enqueue(inbound), /iMessage send failed/);
    const saved = store.getCart("GH78JK");
    assert.equal(saved?.replied, false);
    assert.equal(saved?.isUnlocked, false);
    assert.equal(saved?.status, "locked");
    assert.match(saved?.advice ?? "", /^(Buy|Wait|Skip)\./);
    assert.equal(store.hasHandledInbound("pho_msg_fail_result"), false);

    await runtime.enqueue(inbound);
    const retried = store.getCart("GH78JK");
    assert.equal(attempts, 2);
    assert.equal(retried?.replied, true);
    assert.equal(retried?.isUnlocked, false);
    assert.equal(retried?.status, "locked");
    assert.match(retried?.advice ?? "", /^(Buy|Wait|Skip)\./);
  });

  it("marks replied after a successful send and leaves checkout locked", async () => {
    const store = linkedStore("JK90LM");
    let attempts = 0;
    const runtime = createRuntime({
      store,
      now: () => NOW,
      demoReminderMs: 60_000,
      send: async () => {
        attempts += 1;
      },
      armReminder: () => undefined,
      disarmReminder: () => undefined,
      polish: async (template) => template,
    });
    await runtime.enqueue({
      id: "pho_msg_ok",
      conversationId: SPACE,
      text: "the new color looks nice",
    });
    const saved = store.getCart("JK90LM");
    assert.equal(attempts, 1);
    assert.equal(saved?.replied, true);
    assert.equal(saved?.isUnlocked, false);
    assert.equal(saved?.status, "locked");
    assert.match(saved?.advice ?? "", /^(Buy|Wait|Skip)\./);
    assert.equal(store.hasHandledInbound("pho_msg_ok"), true);
  });

  it("forgets the inbound id when the turn throws before a send", async () => {
    const inner = linkedStore("MN12PQ");
    let failRead = true;
    let attempts = 0;
    const store = {
      getCart(code: string) {
        if (failRead) {
          failRead = false;
          throw new Error("store read failed");
        }
        return inner.getCart(code);
      },
      saveCart: (cart: Parameters<typeof inner.saveCart>[0]) => inner.saveCart(cart),
      listCarts: () => inner.listCarts(),
      getSession: (id: string) => inner.getSession(id),
      saveSession: (session: Parameters<typeof inner.saveSession>[0]) => inner.saveSession(session),
      getPhoneLink: (id: string) => inner.getPhoneLink(id),
      savePhoneLink: (link: Parameters<typeof inner.savePhoneLink>[0]) => inner.savePhoneLink(link),
      findPhoneLinkByConversation: (id: string) => inner.findPhoneLinkByConversation(id),
      hasHandledInbound: (id: string) => inner.hasHandledInbound(id),
      rememberInbound: (id: string) => inner.rememberInbound(id),
      forgetInbound: (id: string) => inner.forgetInbound(id),
      reset: () => inner.reset(),
    };
    const runtime = createRuntime({
      store,
      now: () => NOW,
      demoReminderMs: 60_000,
      send: async () => {
        attempts += 1;
      },
      armReminder: () => undefined,
      disarmReminder: () => undefined,
      polish: async (template) => template,
    });
    const inbound = {
      id: "pho_msg_before_send",
      conversationId: SPACE,
      text: "the new color looks nice",
    };
    await assert.rejects(runtime.enqueue(inbound), /store read failed/);
    assert.equal(attempts, 0);
    assert.equal(store.hasHandledInbound("pho_msg_before_send"), false);
    assert.equal(store.getCart("MN12PQ")?.replied, false);

    await runtime.enqueue(inbound);
    assert.equal(attempts, 1);
    assert.equal(store.getCart("MN12PQ")?.replied, true);
    assert.equal(store.getCart("MN12PQ")?.isUnlocked, false);
    assert.equal(store.hasHandledInbound("pho_msg_before_send"), true);
  });
});

function linkedStore(code: string) {
  const store = createMemoryStore();
  const cart = startLockedCart({
    items: itemsForBag(["Example phone"], 120_000, true),
    totalCents: 120_000,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: `user-impulsive|120000|example phone|${code}`,
    now: NOW,
    demo: true,
    lockMs: 600_000,
    userId: "user-impulsive",
    code,
  });
  cart.necessity = "unnecessary";
  cart.userImpulseScore = 2;
  store.saveCart(cart);
  store.savePhoneLink({
    userId: "user-impulsive",
    conversationId: SPACE,
    linkedAt: NOW.toISOString(),
  });
  return store;
}
