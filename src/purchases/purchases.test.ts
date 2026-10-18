import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import express from "express";
import { JSDOM } from "jsdom";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { bindCheckoutClicks } from "../../extension/src/checkout-record.js";
import { appleAdapter } from "../../extension/src/stores/apple.js";
import { createApp } from "../app.js";
import type { AccountDirectory } from "../auth/accounts.js";
import { connectMongo } from "../auth/db.js";
import { attachAccounts, provisionAssistant } from "../auth/routes.js";
import { readOptionalUser, requireUser, SESSION_COOKIE } from "../auth/session.js";
import { CheckIn } from "../checkins/model.js";
import { InMemoryBackboardClient, type BackboardClient } from "../memory/backboard.js";
import { createMemoryRuntime } from "../memory/runtime.js";
import { createMemoryStore } from "../store.js";
import { PurchaseRecord } from "./model.js";
import { createPurchaseRouter } from "./routes.js";
import { hasRegrettedPurchase, purchaseVoteLine } from "./service.js";

const SECRET = "purchase-test-secret";
let base = "";
let purchaseClient: BackboardClient | undefined;
let purchaseDirectory: AccountDirectory | undefined;

describe("purchase feedback", () => {
  let mongod: MongoMemoryServer;
  let close: () => Promise<void>;
  const writes: string[] = [];
  let failMemory = 0;

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
    await PurchaseRecord.createIndexes();
    const inner = new InMemoryBackboardClient();
    const client: BackboardClient = {
      createAssistant: (input) => inner.createAssistant(input),
      addMemory: async (assistantId, input) => {
        if (failMemory > 0) {
          failMemory -= 1;
          throw new Error("backboard down");
        }
        writes.push(input.content);
        return inner.addMemory(assistantId, input);
      },
      getMemoryOperation: () => inner.getMemoryOperation(),
      searchMemories: (assistantId, query, limit) => inner.searchMemories(assistantId, query, limit),
      sendMessage: (input) => inner.sendMessage(input),
      resetMemories: (assistantId) => inner.resetMemories(assistantId),
    };
    const memory = createMemoryRuntime({}, { client, remote: true });
    purchaseClient = client;
    purchaseDirectory = memory.directory;
    const app = express();
    app.use(express.json());
    attachAccounts(app, {
      jwtSecret: SECRET,
      directory: memory.directory,
      memory,
      provision: provisionAssistant(client, memory.directory),
    });
    app.use(
      "/purchases",
      createPurchaseRouter({
        authenticate: requireUser(SECRET),
        directory: memory.directory,
        client,
        remote: true,
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    close = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  });

  after(async () => {
    await close();
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("does not seed sample purchases when the shopper has no history", async () => {
    const ada = await signup("ada-purchases@example.com");
    const history = await get("/purchases/history?limit=15", ada.cookie);
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.purchases, []);
    assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, isExample: true }), 0);
  });

  it("hides seeded examples and still returns survey purchases", async () => {
    const ada = await signup("ada-filter@example.com");
    await PurchaseRecord.create({
      userId: ada.id,
      item: "Fake AirPods",
      category: "audio",
      price: 179,
      verdict: "sleep",
      feedback: null,
      isExample: true,
      source: "checkout",
    });
    await PurchaseRecord.create({
      userId: ada.id,
      item: "Survey headphones",
      category: "audio",
      price: 99,
      verdict: null,
      feedback: "kept",
      isExample: true,
      source: "survey",
    });
    await PurchaseRecord.create({
      userId: ada.id,
      item: "Real cable",
      category: "cable",
      price: 19,
      verdict: null,
      feedback: null,
      isExample: false,
      source: "checkout",
    });
    const history = await get("/purchases/history?limit=15", ada.cookie);
    const purchases = history.body.purchases as { item: string; source: string; isExample: boolean }[];
    assert.deepEqual(
      purchases.map((row) => row.item),
      ["Real cable"],
    );
    assert.equal(purchases.some((row) => row.item === "Survey headphones" || row.item === "Fake AirPods"), false);
    const example = await PurchaseRecord.findOne({ userId: ada.id, item: "Survey headphones" });
    assert.ok(example);
    const rated = await post(`/purchases/${example._id.toString()}/feedback`, { feedback: "regretted" }, ada.cookie);
    assert.equal(rated.status, 404);
    assert.equal((rated.body as { error: string }).error, "Purchase not found.");
  });

  it("saves, changes, and clears a rating and writes one Backboard line per change", async () => {
    const ada = await signup("ada-rate@example.com");
    await PurchaseRecord.create({
      userId: ada.id,
      item: "AirPods",
      category: "audio",
      price: 179,
      verdict: null,
      feedback: null,
      isExample: false,
      source: "survey",
    });
    const history = await get("/purchases/history", ada.cookie);
    const row = (history.body.purchases as { _id: string; item: string; category: string; price: number; isExample: boolean }[])[0];
    assert.ok(row);
    assert.equal(row.isExample, false);
    const before = writes.length;
    const saved = await post(`/purchases/${row._id}/feedback`, { feedback: "regretted" }, ada.cookie);
    assert.equal(saved.status, 200);
    const purchase = saved.body.purchase as { feedback: string; isExample: boolean; ratedAt: string | null };
    assert.equal(purchase.feedback, "regretted");
    assert.equal(purchase.isExample, false);
    assert.ok(purchase.ratedAt);
    assert.equal(writes.at(-1), purchaseVoteLine("regretted", row.item, row.category, row.price));

    const changed = await post(`/purchases/${row._id}/feedback`, { feedback: "kept" }, ada.cookie);
    assert.equal((changed.body.purchase as { feedback: string }).feedback, "kept");
    assert.equal(writes.at(-1), purchaseVoteLine("kept", row.item, row.category, row.price));
    assert.equal(writes.length, before + 2);

    const same = await post(`/purchases/${row._id}/feedback`, { feedback: "kept" }, ada.cookie);
    assert.equal(writes.length, before + 2);
    assert.equal((same.body.purchase as { feedback: string }).feedback, "kept");

    const cleared = await post(`/purchases/${row._id}/feedback`, { feedback: null }, ada.cookie);
    assert.equal((cleared.body.purchase as { feedback: null; ratedAt: null }).feedback, null);
    assert.equal((cleared.body.purchase as { ratedAt: null }).ratedAt, null);
    assert.equal(writes.length, before + 2);
    assert.equal(await hasRegrettedPurchase(ada.id, row.category), false);
  });

  it("writes the memory line on retry when the first save stored the rating and the write failed", async () => {
    const ada = await signup("ada-retry@example.com");
    await PurchaseRecord.create({
      userId: ada.id,
      item: "Retry buds",
      category: "audio",
      price: 50,
      verdict: null,
      feedback: null,
      isExample: false,
      source: "checkout",
    });
    const history = await get("/purchases/history", ada.cookie);
    const row = (history.body.purchases as { _id: string; item: string; category: string; price: number }[])[0];
    assert.ok(row);
    const before = writes.length;
    failMemory = 1;
    const failed = await post(`/purchases/${row._id}/feedback`, { feedback: "regretted" }, ada.cookie);
    assert.equal(failed.status, 500);
    assert.equal(writes.length, before);
    const retried = await post(`/purchases/${row._id}/feedback`, { feedback: "regretted" }, ada.cookie);
    assert.equal(retried.status, 200);
    assert.equal((retried.body.purchase as { feedback: string }).feedback, "regretted");
    assert.equal(writes.at(-1), purchaseVoteLine("regretted", row.item, row.category, row.price));
    assert.equal(writes.length, before + 1);
    const same = await post(`/purchases/${row._id}/feedback`, { feedback: "regretted" }, ada.cookie);
    assert.equal(same.status, 200);
    assert.equal(writes.length, before + 1);
  });

  it("keeps ratings isolated and the regret helper per user", async () => {
    const ada = await signup("ada-iso@example.com");
    const blake = await signup("blake-iso@example.com");
    await PurchaseRecord.create({
      userId: ada.id,
      item: "Ada phone",
      category: "phone",
      price: 20,
      verdict: null,
      feedback: null,
      isExample: false,
      source: "checkout",
    });
    await PurchaseRecord.create({
      userId: blake.id,
      item: "Blake case",
      category: "case",
      price: 30,
      verdict: null,
      feedback: null,
      isExample: false,
      source: "checkout",
    });
    const adaHistory = await get("/purchases/history", ada.cookie);
    const blakeHistory = await get("/purchases/history", blake.cookie);
    const adaRow = (adaHistory.body.purchases as { _id: string; category: string }[])[0];
    const blakeIds = new Set((blakeHistory.body.purchases as { _id: string }[]).map((row) => row._id));
    assert.ok(adaRow);
    assert.equal(blakeIds.has(adaRow._id), false);

    const denied = await post(`/purchases/${adaRow._id}/feedback`, { feedback: "regretted" }, blake.cookie);
    assert.equal(denied.status, 404);
    assert.equal((denied.body as { error: string }).error, "Purchase not found.");
    const foreignList = await get(`/purchases/history?userId=${ada.id}`, blake.cookie);
    assert.equal(foreignList.status, 400);

    await post(`/purchases/${adaRow._id}/feedback`, { feedback: "regretted" }, ada.cookie);
    assert.equal(await hasRegrettedPurchase(ada.id, adaRow.category), true);
    await PurchaseRecord.create({
      userId: blake.id,
      item: "Example phone",
      category: adaRow.category,
      price: 1,
      feedback: "regretted",
      isExample: true,
    });
    assert.equal(await hasRegrettedPurchase(blake.id, adaRow.category), false);
    assert.equal(await hasRegrettedPurchase(ada.id, "not-a-category"), false);
  });

  it("returns the newest 15 real purchases once any exist", async () => {
    const ada = await signup("ada-cap@example.com");
    const now = Date.now();
    await PurchaseRecord.insertMany(
      Array.from({ length: 16 }, (_, index) => ({
        userId: ada.id,
        item: `Item ${index}`,
        category: "other",
        price: index + 1,
        verdict: "unlock",
        feedback: null,
        isExample: false,
        cartCode: `cap-${ada.id}-${index}`,
        createdAt: new Date(now + index * 1000),
      })),
    );
    const history = await get("/purchases/history?limit=15", ada.cookie);
    const purchases = history.body.purchases as { item: string; isExample: boolean }[];
    assert.equal(purchases.length, 15);
    assert.equal(purchases.every((row) => row.isExample === false), true);
    assert.equal(purchases[0]?.item, "Item 15");
    assert.equal(purchases.some((row) => row.item === "Item 0"), false);
  });

  it("records one purchase when checkout is clicked after unlock", async () => {
    const ada = await signup("ada-checkout@example.com");
    const directory = purchaseDirectory;
    const client = purchaseClient;
    if (!directory || !client) {
      throw new Error("Purchase router dependencies were not ready.");
    }
    const store = createMemoryStore();
    const running = createApp({
      ...demoDeps(),
      store,
      readSession: (req) => readOptionalUser(req, SECRET),
    });
    running.app.use(
      "/purchases",
      createPurchaseRouter({
        authenticate: requireUser(SECRET),
        directory,
        client,
        remote: true,
        loadCart: (code) => store.getCart(code),
      }),
    );
    const server = await listen(running.app);
    try {
      const cable = await postJson(
        server.base,
        "/api/carts",
        { userId: "shopper-auth", itemNames: ["USB-C Charge Cable"], totalCents: 1900, parsed: true, demo: true },
        ada.token,
      );
      assert.equal(cable.status, 201);
      assert.equal((cable.body as { isUnlocked: boolean }).isUnlocked, true);
      assert.equal((cable.body as { necessity: string }).necessity, "necessary");
      assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, isExample: false }), 0);

      const phone = await postJson(
        server.base,
        "/api/carts",
        { userId: "shopper-auth", itemNames: ["iPhone 16"], totalCents: 119_900, parsed: true, demo: true },
        ada.token,
      );
      assert.equal(phone.status, 201);
      const code = (phone.body as { code: string }).code;
      assert.equal((phone.body as { isUnlocked: boolean }).isUnlocked, false);
      assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, isExample: false }), 0);

      const anon = await postJson(server.base, "/purchases", { cartCode: code });
      assert.equal(anon.status, 401);
      const foreign = await postJson(server.base, "/purchases", { cartCode: code, userId: ada.id }, ada.token);
      assert.equal(foreign.status, 400);
      const locked = await postJson(server.base, "/purchases", { cartCode: code }, ada.token);
      assert.equal(locked.status, 409);
      assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, isExample: false }), 0);

      const replied = await postJson(
        server.base,
        "/api/dev/messages",
        { conversationId: `desk:cart-${code}`, text: "the new color looks nice" },
        ada.token,
      );
      assert.equal(replied.status, 200);
      const unlocked = await postJson(server.base, `/api/carts/${code}/unlock`, {}, ada.token);
      assert.equal(unlocked.status, 200);
      assert.equal((unlocked.body as { isUnlocked: boolean }).isUnlocked, true);
      assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, isExample: false }), 0);
      assert.equal(await CheckIn.countDocuments({ userId: ada.id }), 0);

      const dom = new JSDOM(
        `<!doctype html><body>
          <button type="button" id="checkout">Check Out</button>
          <button type="button" id="remove">Remove</button>
        </body>`,
        { url: "https://www.apple.com/shop/bag" },
      );
      const doc = dom.window.document;
      const bag = { code, unlocked: false };
      let calls = 0;
      let inflight = Promise.resolve();
      bindCheckoutClicks(
        doc,
        () => appleAdapter.checkoutButtons(doc),
        () => bag,
        (cartCode) => {
          calls += 1;
          inflight = postJson(server.base, "/purchases", { cartCode }, ada.token).then((result) => {
            if (result.status !== 200 && result.status !== 201) {
              throw new Error(`status ${result.status}`);
            }
          });
          return inflight;
        },
      );
      click(doc, "#checkout");
      await inflight;
      assert.equal(calls, 0);

      bag.unlocked = true;
      click(doc, "#remove");
      await inflight;
      assert.equal(calls, 0);
      click(doc, "#checkout");
      click(doc, "#checkout");
      await inflight;
      assert.equal(calls, 1);
      click(doc, "#checkout");
      await inflight;
      assert.equal(calls, 1);

      const rows = await PurchaseRecord.find({ userId: ada.id, isExample: false });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.item, "iPhone 16");
      assert.equal(rows[0]?.category, "phone");
      assert.equal(rows[0]?.price, 1199);
      assert.equal(rows[0]?.isExample, false);
      assert.equal(rows[0]?.feedback, null);
      assert.equal(rows[0]?.cartCode, code);
      assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, category: "cable" }), 0);
      const checkIns = await CheckIn.find({ purchaseId: rows[0]?._id });
      assert.equal(checkIns.length, 1);
      assert.equal(checkIns[0]?.sentAt, null);
      assert.equal(checkIns[0]?.answer, null);

      const again = await postJson(server.base, "/purchases", { cartCode: code }, ada.token);
      assert.equal(again.status, 200);
      assert.equal((again.body as { purchase: { _id: string; isExample: boolean } }).purchase._id, rows[0]?._id.toString());
      assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, isExample: false }), 1);
      assert.equal(await CheckIn.countDocuments({ purchaseId: rows[0]?._id }), 1);
    } finally {
      await server.close();
    }
  });
});

function demoDeps() {
  return {
    store: createMemoryStore(),
    origin: "http://127.0.0.1",
    lockMs: 600_000,
    demoReminderMs: 60_000,
    demoDefault: false,
    agentHandle: null,
    photon: null,
    xaiModel: "grok-4.20-0309-non-reasoning",
    xaiTimeoutMs: 8_000,
    polish: async (template: string) => template,
  };
}

async function signup(email: string): Promise<{ id: string; cookie: string; token: string }> {
  const response = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  const body = (await response.json()) as { user: { id: string }; token?: unknown };
  const cookie = readCookie(response);
  if (!cookie || typeof body.token !== "string") {
    throw new Error("signup did not return a session");
  }
  return { id: body.user.id, cookie, token: body.token };
}

async function get(path: string, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function post(path: string, body: unknown, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${cookie}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(
  urlBase: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${urlBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function click(doc: { querySelector(selector: string): { dispatchEvent(event: object): boolean } | null; defaultView: { MouseEvent: new (type: string, init?: object) => object } | null }, selector: string): void {
  const node = doc.querySelector(selector);
  assert.ok(node);
  const view = doc.defaultView;
  assert.ok(view);
  node.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function readCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const line = (headers.getSetCookie?.() ?? []).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (!line) {
    return null;
  }
  return decodeURIComponent((line.split(";")[0] ?? "").slice(`${SESSION_COOKIE}=`.length));
}
