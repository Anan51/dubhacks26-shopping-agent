import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createApp } from "./app.js";
import type { PhotonChannel } from "./channels/photon.js";
import { createMemoryStore, type Store } from "./store.js";
import type { Cart } from "./types.js";

const SPACE = "pho_spc_00000000000000000000000000";
const ACCOUNT_A = "user-account-a";
const ACCOUNT_B = "user-account-b";
const B_ADVICE = "Wait. Your current phone is broken. Give it a little time before you check out.";

/**
 * Both accounts text the same Photon thread. Account A's reply leaves
 * session.cartCode on A's cart. Account B's checkout ping must repoint that
 * session, or a later reply with no cart code is graded onto A.
 */
describe("shared phone thread", () => {
  it("grades a codeless reply onto B after B pings the thread A already used", async () => {
    const store = createMemoryStore();
    store.savePhoneLink({
      userId: ACCOUNT_B,
      conversationId: SPACE,
      linkedAt: "2026-10-18T00:00:00.000Z",
    });
    store.savePhoneLink({
      userId: ACCOUNT_A,
      conversationId: SPACE,
      agentSenderId: "pho_usr_agent",
      linkedAt: "2026-10-18T00:00:01.000Z",
    });
    const running = await listen(store);
    try {
      const cartA = await postCart(running.base, ACCOUNT_A);
      await running.runtime.enqueue({
        id: "pho_msg_account_a",
        conversationId: SPACE,
        text: "the new color looks nice",
        agentSenderId: "pho_usr_agent",
      });
      const aBefore = await getCart(running.base, cartA);
      assert.equal(aBefore.replied, true);
      assert.match(aBefore.advice ?? "", /^Skip\./);
      assert.equal(store.getSession(SPACE)?.cartCode, cartA);

      const cartB = await postCart(running.base, ACCOUNT_B);
      assert.notEqual(cartB, cartA);
      const pointed = store.getSession(SPACE);
      assert.equal(pointed?.cartCode, cartB);
      assert.equal(pointed?.step, "need_code");
      assert.notEqual(pointed?.signals.needVsWant, "want");

      await running.runtime.enqueue({
        id: "pho_msg_account_b",
        conversationId: SPACE,
        text: "cracked screen",
        agentSenderId: "pho_usr_agent",
      });

      const aAfter = await getCart(running.base, cartA);
      const bAfter = await getCart(running.base, cartB);
      assert.equal(bAfter.advice, B_ADVICE);
      assert.equal(bAfter.replied, true);
      assert.equal(bAfter.userId, ACCOUNT_B);
      assert.equal(bAfter.signals.currentPhoneBroken, true);
      assert.equal(aAfter.advice, aBefore.advice);
      assert.equal(aAfter.replied, true);
      assert.equal(aAfter.explanation, aBefore.explanation);
      assert.deepEqual(aAfter.decision, aBefore.decision);
      assert.equal(aAfter.signals.currentPhoneBroken, aBefore.signals.currentPhoneBroken);
      assert.equal(aAfter.signals.needVsWant, aBefore.signals.needVsWant);
      assert.equal(store.getSession(SPACE)?.cartCode, cartB);
      assert.notEqual(aAfter.advice, bAfter.advice);
    } finally {
      await running.close();
    }
  });

  it("grades a codeless reply onto the only cart a phone ping pointed at", async () => {
    const store = createMemoryStore();
    store.savePhoneLink({
      userId: ACCOUNT_A,
      conversationId: SPACE,
      linkedAt: "2026-10-18T00:00:00.000Z",
    });
    const running = await listen(store);
    try {
      const code = await postCart(running.base, ACCOUNT_A);
      assert.equal(store.getSession(SPACE)?.cartCode, code);
      await running.runtime.enqueue({
        id: "pho_msg_only",
        conversationId: SPACE,
        text: "cracked screen",
      });
      const cart = await getCart(running.base, code);
      assert.equal(cart.advice, B_ADVICE);
      assert.equal(cart.replied, true);
      assert.equal(cart.userId, ACCOUNT_A);
    } finally {
      await running.close();
    }
  });
});

describe("desk ping", () => {
  it("leaves the desk session on the first cart when another cart pings that desk", async () => {
    const store = createMemoryStore();
    const running = await listen(store);
    try {
      const cartA = await postCart(running.base, ACCOUNT_A);
      const cartB = await postCart(running.base, ACCOUNT_B);
      const conversationId = "desk:shared-thread1";
      assert.equal((await postJson(running.base, "/api/dev/link", { userId: ACCOUNT_A, conversationId })).status, 200);
      assert.equal((await postJson(running.base, `/api/carts/${cartA}/notify`, {})).status, 200);
      assert.equal(store.getSession(conversationId)?.cartCode, cartA);
      assert.equal((await postJson(running.base, "/api/dev/link", { userId: ACCOUNT_B, conversationId })).status, 200);
      assert.equal((await postJson(running.base, `/api/carts/${cartB}/notify`, {})).status, 200);
      assert.equal(store.getSession(conversationId)?.cartCode, cartA);
      assert.equal(store.getSession(conversationId)?.step, "need_code");

      await running.runtime.enqueue({
        id: "desk-shared-reply",
        conversationId,
        text: "cracked screen",
      });
      const graded = await getCart(running.base, cartA);
      const untouched = await getCart(running.base, cartB);
      assert.equal(graded.replied, true);
      assert.match(graded.advice ?? "", /Your current phone is broken/);
      assert.equal(untouched.replied, false);
      assert.equal(untouched.advice, null);
    } finally {
      await running.close();
    }
  });
});

async function listen(store: Store): Promise<{
  base: string;
  runtime: ReturnType<typeof createApp>["runtime"];
  close: () => Promise<void>;
}> {
  const photon = {
    onDelivery() {
      return undefined;
    },
    send: async () => undefined,
  } as unknown as PhotonChannel;
  const running = createApp({
    store,
    origin: "http://127.0.0.1",
    lockMs: 600_000,
    demoReminderMs: 60_000,
    demoDefault: true,
    agentHandle: "+15550001111",
    photon,
    xaiModel: "grok-4.20-0309-non-reasoning",
    xaiTimeoutMs: 8_000,
    polish: async (template) => template,
  });
  const server = createServer(running.app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    runtime: running.runtime,
    close: () =>
      new Promise((resolve, reject) => {
        running.scheduler.stop();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await response.json();
  return { status: response.status };
}

async function postCart(base: string, userId: string): Promise<string> {
  const response = await fetch(`${base}/api/carts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId,
      itemNames: ["Example phone"],
      totalCents: 119_900,
      parsed: true,
      demo: true,
    }),
  });
  const body = (await response.json()) as { code?: string; error?: string };
  assert.equal(response.status, 201, body.error);
  assert.equal(typeof body.code, "string");
  return body.code ?? "";
}

async function getCart(base: string, code: string): Promise<Cart> {
  const response = await fetch(`${base}/api/carts/${code}`);
  assert.equal(response.status, 200);
  return (await response.json()) as Cart;
}
