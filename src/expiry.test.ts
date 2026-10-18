import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, mock } from "node:test";

import { createApp } from "./app.js";
import { itemsForBag, lockState, startLockedCart, VAULT_MS } from "./carts.js";
import type { OutboundMessage } from "./channel.js";
import { ReminderScheduler } from "./reminders.js";
import { createMemoryStore, type Store } from "./store.js";
import type { Cart } from "./types.js";

const START = new Date("2026-10-18T00:00:00.000Z");
const WAIT_MS = 5_000;

describe("countdown expiry", () => {
  it("fires the reminder once at the deadline", async () => {
    await withFakeTimers(async () => {
      const sent: OutboundMessage[] = [];
      const clock = { at: new Date(START) };
      const store = createMemoryStore();
      const cart = dueCart({ conversationId: "desk:cart-CART23" });
      store.saveCart(cart);
      const scheduler = schedulerFor(store, sent, clock);
      scheduler.arm(cart);

      mock.timers.tick(WAIT_MS - 1);
      await flush();
      assert.equal(sent.length, 0);

      clock.at = new Date(START.getTime() + WAIT_MS);
      mock.timers.tick(1);
      await flush();

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.idempotencyKey, `simmer:reminder:CART23:${cart.reminderFireAt}`);
      const opened = store.getCart("CART23");
      assert.equal(opened?.status, "unlocked");
      assert.equal(opened?.unlockReason, "timer");

      clock.at = new Date(START.getTime() + WAIT_MS + 30_000);
      mock.timers.tick(30_000);
      scheduler.armPending();
      await flush();
      assert.equal(sent.length, 1);
      scheduler.stop();
    });
  });

  it("sweeps a past-due reminder once after restart", async () => {
    await withFakeTimers(async () => {
      const sent: OutboundMessage[] = [];
      const clock = { at: new Date(START) };
      const store = createMemoryStore();
      const fireAt = new Date(START.getTime() - 1_000).toISOString();
      store.saveCart(dueCart({ conversationId: "desk:cart-CART23", reminderAt: fireAt, reminderFireAt: fireAt }));

      const booted = schedulerFor(store, sent, clock);
      booted.armPending();
      await flush();
      booted.stop();

      const restarted = schedulerFor(store, sent, clock);
      restarted.armPending();
      await flush();
      restarted.stop();

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.idempotencyKey, `simmer:reminder:CART23:${fireAt}`);
      assert.equal(store.getCart("CART23")?.reminderSentAt == null, false);
    });
  });

  it("keeps a strict enforced vault locked when the early reminder fires", async () => {
    await withFakeTimers(async () => {
      const sent: OutboundMessage[] = [];
      const clock = { at: new Date(START) };
      const store = createMemoryStore();
      const vaultUntil = new Date(START.getTime() + VAULT_MS).toISOString();
      const cart = dueCart({
        status: "vault",
        vaultMode: "enforced",
        vaultUntil,
        purchaseScore: 1,
        scoreBucket: "strict",
        conversationId: "desk:cart-CART23",
      });
      store.saveCart(cart);
      const scheduler = schedulerFor(store, sent, clock);
      scheduler.arm(cart);
      clock.at = new Date(START.getTime() + WAIT_MS);
      mock.timers.tick(WAIT_MS);
      await flush();
      scheduler.stop();

      const held = store.getCart("CART23");
      assert.ok(held);
      assert.equal(held.status, "vault");
      assert.equal(held.isUnlocked, false);
      assert.equal(held.unlockReason, null);
      assert.equal(held.vaultUntil, vaultUntil);
      assert.equal(lockState(held, clock.at).ok, false);
      assert.equal(sent.length, 1);
    });
  });

  it("unlocks a non-vaulted unnecessary bag at 0:00", async () => {
    await withFakeTimers(async () => {
      const sent: OutboundMessage[] = [];
      const clock = { at: new Date(START) };
      const store = createMemoryStore();
      const cart = dueCart({
        necessity: "unnecessary",
        status: "locked",
        vaultUntil: null,
        vaultMode: null,
        purchaseScore: null,
        conversationId: "desk:cart-CART23",
      });
      store.saveCart(cart);
      const scheduler = schedulerFor(store, sent, clock);
      scheduler.arm(cart);
      clock.at = new Date(START.getTime() + WAIT_MS);
      mock.timers.tick(WAIT_MS);
      await flush();
      scheduler.stop();

      const opened = store.getCart("CART23");
      assert.ok(opened);
      assert.equal(opened.status, "unlocked");
      assert.equal(opened.isUnlocked, true);
      assert.equal(opened.unlockReason, "timer");
      assert.equal(lockState(opened, clock.at).ok, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.idempotencyKey, `simmer:reminder:CART23:${cart.reminderFireAt}`);
    });
  });

  it("unlocks before the send and retries a failed send once", async () => {
    await withFakeTimers(async () => {
      const keys: string[] = [];
      let calls = 0;
      const clock = { at: new Date(START.getTime() + WAIT_MS) };
      const store = createMemoryStore();
      const fireAt = new Date(START.getTime() + WAIT_MS).toISOString();
      store.saveCart(
        dueCart({
          conversationId: "desk:cart-CART23",
          reminderAt: fireAt,
          reminderFireAt: fireAt,
          vaultUntil: null,
        }),
      );
      const scheduler = new ReminderScheduler({
        store,
        origin: "http://127.0.0.1",
        now: () => clock.at,
        send: async (message) => {
          calls += 1;
          keys.push(message.idempotencyKey);
          if (calls === 1) {
            throw new Error("down");
          }
        },
      });
      scheduler.armPending();
      await flush();
      const opened = store.getCart("CART23");
      assert.equal(opened?.status, "unlocked");
      assert.equal(opened?.unlockReason, "timer");
      assert.equal(opened?.reminderSentAt, null);
      assert.equal(calls, 1);

      mock.timers.tick(5_000);
      await flush();
      assert.equal(calls, 2);
      assert.equal(keys[0], keys[1]);
      assert.equal(keys[0], `simmer:reminder:CART23:${fireAt}`);
      assert.equal(store.getCart("CART23")?.reminderSentAt == null, false);

      mock.timers.tick(10_000);
      await flush();
      assert.equal(calls, 2);
      scheduler.stop();
    });
  });

  it("leaves an already unlocked cart untouched", async () => {
    await withFakeTimers(async () => {
      const sent: OutboundMessage[] = [];
      const clock = { at: new Date(START) };
      const store = createMemoryStore();
      const fireAt = new Date(START.getTime() - 1_000).toISOString();
      store.saveCart(
        dueCart({
          status: "unlocked",
          isUnlocked: true,
          unlockReason: null,
          reminderAt: fireAt,
          reminderFireAt: fireAt,
          conversationId: "desk:cart-CART23",
          explanation: "keep",
        }),
      );
      const before = store.getCart("CART23");
      const scheduler = schedulerFor(store, sent, clock);
      scheduler.armPending();
      await flush();
      scheduler.stop();
      assert.equal(sent.length, 0);
      assert.deepEqual(store.getCart("CART23"), before);
    });
  });

  it("unlocks a cart with no conversation and does not send", async () => {
    await withFakeTimers(async () => {
      const sent: OutboundMessage[] = [];
      const clock = { at: new Date(START) };
      const store = createMemoryStore();
      const fireAt = new Date(START.getTime() - 1_000).toISOString();
      store.saveCart(dueCart({ conversationId: null, reminderAt: fireAt, reminderFireAt: fireAt }));
      const scheduler = schedulerFor(store, sent, clock);
      scheduler.armPending();
      await flush();
      scheduler.stop();
      const opened = store.getCart("CART23");
      assert.equal(sent.length, 0);
      assert.equal(opened?.status, "unlocked");
      assert.equal(opened?.isUnlocked, true);
      assert.equal(opened?.unlockReason, "timer");
      assert.equal(opened?.reminderSentAt == null, false);
    });
  });

  it("does not unlock a low score that is waiting on Unlock", async () => {
    await withFakeTimers(async () => {
      const sent: OutboundMessage[] = [];
      const clock = { at: new Date(START) };
      const store = createMemoryStore();
      const fireAt = new Date(START.getTime() - 1_000).toISOString();
      store.saveCart(
        dueCart({
          purchaseScore: 1,
          scoreBucket: "strict",
          conversationId: "desk:cart-CART23",
          reminderAt: fireAt,
          reminderFireAt: fireAt,
        }),
      );
      const scheduler = schedulerFor(store, sent, clock);
      scheduler.armPending();
      await flush();
      scheduler.armPending();
      await flush();
      scheduler.stop();
      const held = store.getCart("CART23");
      assert.equal(sent.length, 1);
      assert.equal(held?.status, "locked");
      assert.equal(held?.isUnlocked, false);
      assert.equal(held?.unlockReason, null);
    });
  });
});

describe("demo countdown", () => {
  it("uses the short demo timer and opens the bag when that deadline passes", async () => {
    let clock = new Date("2026-10-18T15:00:00.000Z");
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 1_500,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      now: () => clock,
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await post(base, "/api/carts", {
        userId: "user-expiry",
        itemNames: ["Example phone"],
        totalCents: 120_000,
        parsed: true,
      });
      assert.equal(created.status, 201);
      const body = created.body as {
        status: string;
        createdAt: string;
        lockEndsAt: string;
        reminderFireAt: string | null;
        isUnlocked: boolean;
      };
      assert.equal(body.status, "locked");
      assert.equal(body.isUnlocked, false);
      assert.equal(Date.parse(body.lockEndsAt) - Date.parse(body.createdAt), 1_500);
      assert.equal(body.reminderFireAt, body.lockEndsAt);

      running.scheduler.stop();
      clock = new Date(clock.getTime() + 1_500);
      running.scheduler.armPending();
      await flush();

      const opened = await fetch(`${base}/api/carts/${(created.body as { code: string }).code}`);
      const after = (await opened.json()) as { status: string; isUnlocked: boolean; unlockReason: string | null };
      assert.equal(after.status, "unlocked");
      assert.equal(after.isUnlocked, true);
      assert.equal(after.unlockReason, "timer");
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function dueCart(partial: Partial<Cart>): Cart {
  const cart = startLockedCart({
    items: itemsForBag(["Example phone"], 120_000, true),
    totalCents: 120_000,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: "user-expiry|120000|example phone",
    now: START,
    demo: false,
    lockMs: 600_000,
    userId: "user-expiry",
    code: "CART23",
  });
  cart.necessity = "unnecessary";
  const fireAt = new Date(START.getTime() + WAIT_MS).toISOString();
  cart.reminderAt = fireAt;
  cart.reminderFireAt = fireAt;
  return { ...cart, ...partial };
}

function schedulerFor(store: Store, sent: OutboundMessage[], clock: { at: Date }): ReminderScheduler {
  return new ReminderScheduler({
    store,
    origin: "http://127.0.0.1",
    now: () => clock.at,
    send: async (message) => {
      sent.push(message);
    },
  });
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await run();
  } finally {
    mock.timers.reset();
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
