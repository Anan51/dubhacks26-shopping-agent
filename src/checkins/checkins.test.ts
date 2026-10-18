import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { createApp } from "../app.js";
import { connectMongo } from "../auth/db.js";
import { attachAccounts } from "../auth/routes.js";
import { requireUser, SESSION_COOKIE } from "../auth/session.js";
import { InMemoryBackboardClient } from "../memory/backboard.js";
import { createMemoryRuntime } from "../memory/runtime.js";
import { PurchaseRecord } from "../purchases/model.js";
import { createPurchaseRouter } from "../purchases/routes.js";
import { createMemoryStore } from "../store.js";
import { demoCheckInsAllowed } from "./demo.js";
import { CheckIn } from "./model.js";
import { parseWorthReply } from "./reply.js";
import { startCheckInLoop } from "./scheduler.js";
import { rememberCheckIn } from "./ensure.js";
import { answerCheckIn, ensureCheckIn, sendDueCheckIns, takeCheckInReply } from "./service.js";

const SECRET = "checkin-test-secret";
let base = "";

describe("worth-it replies", () => {
  it("accepts yes, no, and thumbs, and leaves other texts alone", () => {
    assert.equal(parseWorthReply("Yes"), "yes");
    assert.equal(parseWorthReply("y"), "yes");
    assert.equal(parseWorthReply("YES!"), "yes");
    assert.equal(parseWorthReply("👍"), "yes");
    assert.equal(parseWorthReply("👍🏽"), "yes");
    assert.equal(parseWorthReply("no"), "no");
    assert.equal(parseWorthReply("N"), "no");
    assert.equal(parseWorthReply("no."), "no");
    assert.equal(parseWorthReply("👎"), "no");
    assert.equal(parseWorthReply("yes please"), null);
    assert.equal(parseWorthReply("yesterday"), null);
    assert.equal(parseWorthReply("unlock"), null);
  });
});

describe("check-ins", { concurrency: false }, () => {
  let mongod: MongoMemoryServer;
  let close: () => Promise<void>;
  let stopCheckIns: () => void;
  const store = createMemoryStore();
  const sent: string[] = [];
  const client = new InMemoryBackboardClient();

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
    const memory = createMemoryRuntime({}, { client, remote: false });
    const running = createApp({
      store,
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: false,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      polish: async (template) => template,
      checkIns: {
        directory: memory.directory,
        client,
        remote: false,
        intervalMs: 3_600_000,
      },
    });
    stopCheckIns = running.stopCheckIns;
    const app = running.app;
    app.use(
      "/purchases",
      createPurchaseRouter({
        authenticate: requireUser(SECRET),
        directory: memory.directory,
        client,
        remote: false,
      }),
    );
    attachAccounts(app, { jwtSecret: SECRET, directory: memory.directory, memory });
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  after(async () => {
    stopCheckIns();
    await close();
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("skips a purchase the shopper already rated and still saves the purchase when the check-in write fails", async () => {
    const ada = await signup("ada-rated@example.com");
    const rated = await PurchaseRecord.create({
      userId: ada.id,
      item: "Rated case",
      category: "case",
      price: 12,
      feedback: "kept",
      isExample: false,
      source: "checkout",
    });
    await rememberCheckIn(ada.id, rated.id);
    assert.equal(await CheckIn.countDocuments({ purchaseId: rated.id }), 0);

    const created = await post("/purchases", { item: "Open phone", category: "phone", price: 40, verdict: null }, ada.cookie);
    assert.equal(created.status, 201);
    await rememberCheckIn(ada.id, "not-a-purchase-id");
    const purchaseId = (created.body.purchase as { _id: string })._id;
    assert.equal(await CheckIn.countDocuments({ purchaseId }), 1);
  });

  it("does not text a check-in after the popup already rated it", async () => {
    const ada = await signup("ada-skip@example.com");
    const purchase = await PurchaseRecord.create({
      userId: ada.id,
      item: "Skipped watch",
      category: "watch",
      price: 80,
      feedback: null,
      isExample: false,
      source: "checkout",
    });
    await ensureCheckIn(ada.id, purchase.id, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    purchase.feedback = "kept";
    await purchase.save();
    const sent = await sendDueCheckIns({
      now: new Date(),
      linkFor: () => ({ conversationId: "desk:skip" }),
      send: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(sent, 0);
    const row = await CheckIn.findOne({ purchaseId: purchase.id });
    assert.equal(row?.answer, "yes");
    assert.ok(row?.answeredAt);
    assert.equal(row?.sentAt, null);
  });

  it("creates one check-in due in 7 days and does not duplicate it", async () => {
    const ada = await signup("ada-checkin@example.com");
    const created = await post("/purchases", { item: "Example phone", category: "phone", price: 80, verdict: null }, ada.cookie);
    assert.equal(created.status, 201);
    const purchaseId = (created.body.purchase as { _id: string })._id;
    const row = await CheckIn.findOne({ purchaseId });
    assert.ok(row);
    const dueMs = row.dueAt.getTime() - Date.now();
    assert.ok(Math.abs(dueMs - 7 * 24 * 60 * 60 * 1000) < 10_000);
    assert.equal(row.sentAt, null);
    const dueAt = row.dueAt.getTime();
    await ensureCheckIn(ada.id, purchaseId, new Date("2020-01-01T00:00:00.000Z"));
    const again = await CheckIn.find({ purchaseId });
    assert.equal(again.length, 1);
    assert.equal(again[0]?.dueAt.getTime(), dueAt);
  });

  it("sends due check-ins on the stub channel and retries a failed send", async () => {
    const ada = await signup("ada-send@example.com");
    const purchase = await PurchaseRecord.create({
      userId: ada.id,
      item: "Headphones",
      category: "audio",
      price: 50,
      feedback: null,
      isExample: false,
      source: "checkout",
    });
    await ensureCheckIn(ada.id, purchase.id, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    const unlinked = await sendDueCheckIns({
      now: new Date(),
      linkFor: () => null,
      send: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(unlinked, 0);
    assert.equal((await CheckIn.findOne({ purchaseId: purchase.id }))?.sentAt, null);

    store.savePhoneLink({
      userId: ada.id,
      conversationId: "desk:check-ada",
      linkedAt: new Date().toISOString(),
    });
    let failed = true;
    const outbound: string[] = [];
    const first = await sendDueCheckIns({
      now: new Date(),
      linkFor: (userId) => (userId === ada.id ? { conversationId: "desk:check-ada" } : null),
      send: async (message) => {
        if (failed) {
          throw new Error("stub down");
        }
        outbound.push(message.text);
      },
    });
    assert.equal(first, 0);
    assert.equal((await CheckIn.findOne({ purchaseId: purchase.id }))?.sentAt, null);

    failed = false;
    const second = await sendDueCheckIns({
      now: new Date(),
      linkFor: (userId) => (userId === ada.id ? { conversationId: "desk:check-ada" } : null),
      send: async (message) => {
        outbound.push(message.text);
      },
    });
    assert.equal(second, 1);
    assert.equal(outbound[0], "Quick check: was your Headphones worth it? Reply yes or no.");
    assert.ok((await CheckIn.findOne({ purchaseId: purchase.id }))?.sentAt);
    sent.push(...outbound);
  });

  it("turns a linked yes or no into kept or regretted on that shopper's purchase only", async () => {
    const ada = await signup("ada-reply@example.com");
    const blake = await signup("blake-reply@example.com");
    const memory = createMemoryRuntime({}, { client, remote: false });
    const older = await PurchaseRecord.create({
      userId: ada.id,
      item: "Case",
      category: "case",
      price: 20,
      feedback: null,
      isExample: false,
    });
    const newer = await PurchaseRecord.create({
      userId: ada.id,
      item: "Watch",
      category: "watch",
      price: 90,
      feedback: null,
      isExample: false,
    });
    const foreign = await PurchaseRecord.create({
      userId: blake.id,
      item: "Blake phone",
      category: "phone",
      price: 40,
      feedback: null,
      isExample: false,
    });
    const now = new Date();
    await CheckIn.create({
      userId: ada.id,
      purchaseId: older.id,
      dueAt: now,
      sentAt: new Date(now.getTime() - 2_000),
      answeredAt: null,
      answer: null,
    });
    await CheckIn.create({
      userId: ada.id,
      purchaseId: newer.id,
      dueAt: now,
      sentAt: new Date(now.getTime() - 1_000),
      answeredAt: null,
      answer: null,
    });
    await CheckIn.create({
      userId: blake.id,
      purchaseId: foreign.id,
      dueAt: now,
      sentAt: now,
      answeredAt: null,
      answer: null,
    });

    const ignored = await takeCheckInReply(ada.id, "the new color looks nice", memory, now);
    assert.equal(ignored, false);
    assert.equal((await PurchaseRecord.findById(newer.id))?.feedback ?? null, null);

    const unsent = await PurchaseRecord.create({
      userId: ada.id,
      item: "Cable",
      category: "cable",
      price: 15,
      feedback: null,
      isExample: false,
    });
    await CheckIn.create({
      userId: ada.id,
      purchaseId: unsent.id,
      dueAt: now,
      sentAt: null,
      answeredAt: null,
      answer: null,
    });

    assert.equal(await takeCheckInReply(null, "yes", memory, now), false);
    const answered = await takeCheckInReply(ada.id, "No", memory, now);
    assert.equal(answered, true);
    assert.equal((await PurchaseRecord.findById(newer.id))?.feedback, "regretted");
    assert.equal((await PurchaseRecord.findById(older.id))?.feedback ?? null, null);
    assert.equal((await PurchaseRecord.findById(foreign.id))?.feedback ?? null, null);

    const blakeOpen = await answerCheckIn(blake.id, "yes", memory, now);
    assert.equal(blakeOpen, true);
    assert.equal((await PurchaseRecord.findById(foreign.id))?.feedback, "kept");
    assert.equal((await PurchaseRecord.findById(newer.id))?.feedback, "regretted");
  });

  it("rejects the demo fire route unless the demo flag is on outside production", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousDemo = process.env.WAITMATE_DEMO;
    try {
      process.env.NODE_ENV = "production";
      process.env.WAITMATE_DEMO = "1";
      assert.equal(demoCheckInsAllowed(), false);
      const blocked = await post("/api/dev/checkins/64b0000000000000000000aa/fire", {}, "");
      assert.equal(blocked.status, 403);

      process.env.NODE_ENV = "test";
      delete process.env.WAITMATE_DEMO;
      assert.equal(demoCheckInsAllowed(), false);
      const off = await post("/api/dev/checkins/64b0000000000000000000aa/fire", {}, "");
      assert.equal(off.status, 403);
    } finally {
      restoreEnv("NODE_ENV", previousNode);
      restoreEnv("WAITMATE_DEMO", previousDemo);
    }
  });

  it("fires a due check-in through the stub desk thread when the demo is on", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousDemo = process.env.WAITMATE_DEMO;
    const ada = await signup("ada-fire@example.com");
    const purchase = await PurchaseRecord.create({
      userId: ada.id,
      item: "Tablet",
      category: "tablet",
      price: 300,
      feedback: null,
      isExample: false,
    });
    await ensureCheckIn(ada.id, purchase.id);
    store.savePhoneLink({
      userId: ada.id,
      conversationId: "desk:fire-ada",
      linkedAt: new Date().toISOString(),
    });
    try {
      process.env.NODE_ENV = "test";
      process.env.WAITMATE_DEMO = "1";
      const fired = await post(`/api/dev/checkins/${purchase.id}/fire`, {}, "");
      assert.equal(fired.status, 200);
      assert.equal((fired.body as { sent: number }).sent, 1);
      const thread = await fetch(`${base}/api/dev/messages?conversationId=desk:fire-ada`);
      const body = (await thread.json()) as { turns: { text: string }[] };
      assert.match(body.turns.map((turn) => turn.text).join("\n"), /was your Tablet worth it/);
      const row = await CheckIn.findOne({ purchaseId: purchase.id });
      assert.ok(row?.sentAt);
    } finally {
      restoreEnv("NODE_ENV", previousNode);
      restoreEnv("WAITMATE_DEMO", previousDemo);
    }
  });

  it("leaves cart routing in place when the text is not a yes or no", async () => {
    const created = await post(
      "/api/carts",
      { userId: "user-checkin-cart", itemNames: ["Example phone"], totalCents: 90_000, parsed: true, demo: true },
      "",
    );
    assert.equal(created.status, 201);
    const code = (created.body as { code: string }).code;
    store.savePhoneLink({
      userId: "user-checkin-cart",
      conversationId: `desk:cart-${code}`,
      linkedAt: new Date().toISOString(),
    });
    const reply = await post("/api/dev/messages", { conversationId: `desk:cart-${code}`, text: "the new color looks nice" }, "");
    assert.equal(reply.status, 200);
    const cart = (await (await fetch(`${base}/api/carts/${code}`)).json()) as {
      scoreBucket: string | null;
      status: string;
      isUnlocked: boolean;
    };
    assert.equal(cart.scoreBucket, "strict");
    assert.equal(cart.status, "locked");
    assert.equal(cart.isUnlocked, false);

    const yesBag = await post(
      "/api/carts",
      { userId: "user-yes-cart", itemNames: ["Example phone"], totalCents: 90_000, parsed: true, demo: true },
      "",
    );
    const yesCode = (yesBag.body as { code: string }).code;
    store.savePhoneLink({
      userId: "user-yes-cart",
      conversationId: `desk:cart-${yesCode}`,
      linkedAt: new Date().toISOString(),
    });
    const yes = await post("/api/dev/messages", { conversationId: `desk:cart-${yesCode}`, text: "yes" }, "");
    assert.equal(yes.status, 200);
    const yesThread = (await (await fetch(`${base}/api/dev/messages?conversationId=desk:cart-${yesCode}`)).json()) as {
      turns: { role: string; text: string }[];
    };
    assert.equal(yesThread.turns.some((turn) => turn.role === "agent" && turn.text.length > 0), true);
    const yesCart = (await (await fetch(`${base}/api/carts/${yesCode}`)).json()) as {
      status: string;
      scoreBucket: string | null;
      isUnlocked: boolean;
    };
    assert.equal(yesCart.status, "locked");
    assert.equal(yesCart.isUnlocked, false);
    assert.equal(yesCart.scoreBucket, null);
  });

  it("sends a due row from the scheduler loop", async () => {
    const purchase = await PurchaseRecord.create({
      userId: new mongoose.Types.ObjectId(),
      item: "Loop headphones",
      category: "audio",
      price: 10,
      feedback: null,
      isExample: false,
    });
    await CheckIn.create({
      userId: purchase.userId,
      purchaseId: purchase.id,
      dueAt: new Date(Date.now() - 1_000),
      sentAt: null,
      answeredAt: null,
      answer: null,
    });
    const texts: string[] = [];
    const loop = startCheckInLoop({
      now: () => new Date(),
      intervalMs: 60_000,
      linkFor: (userId) => (userId === purchase.userId.toString() ? { conversationId: "desk:loop" } : null),
      send: async (message) => {
        texts.push(message.text);
      },
    });
    try {
      await waitFor(() => texts.length === 1);
      assert.match(texts[0] ?? "", /Loop headphones/);
    } finally {
      loop.stop();
    }
  });
});

function restoreEnv(name: "NODE_ENV" | "WAITMATE_DEMO", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 2_000) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function signup(email: string): Promise<{ id: string; cookie: string }> {
  const response = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  const body = (await response.json()) as { user?: { id: string }; error?: string };
  assert.equal(response.status, 201, body.error);
  const cookie = readCookie(response);
  assert.ok(cookie);
  assert.ok(body.user);
  return { id: body.user.id, cookie };
}

async function post(path: string, body: unknown, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) {
    headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  }
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function readCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const line = (headers.getSetCookie?.() ?? []).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (!line) {
    return null;
  }
  return decodeURIComponent((line.split(";")[0] ?? "").slice(`${SESSION_COOKIE}=`.length));
}
