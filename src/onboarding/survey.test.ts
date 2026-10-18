import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import express from "express";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";

import type { AccountDirectory } from "../auth/accounts.js";
import { connectMongo } from "../auth/db.js";
import { attachAccounts, provisionAssistant } from "../auth/routes.js";
import { requireUser, SESSION_COOKIE } from "../auth/session.js";
import { User } from "../auth/user.js";
import { InMemoryBackboardClient, type BackboardClient } from "../memory/backboard.js";
import { createMemoryRuntime } from "../memory/runtime.js";
import { PurchaseRecord } from "../purchases/model.js";
import { createPurchaseRouter } from "../purchases/routes.js";
import { budgetMemoryLine, countRegrets, getBudgetProfile, getHourlyRate, getSavedGoals, getWeeklyBudget, hasRegrettedPurchase, purchaseVoteLine, weeklySpend, writeUserMemoryLine } from "../purchases/service.js";
import { positiveSettingsAmount } from "./service.js";
import { createOnboardingRouter, createSettingsRouter } from "./routes.js";

const SECRET = "survey-test-secret";
let base = "";

describe("onboarding survey", () => {
  let mongod: MongoMemoryReplSet;
  let close: () => Promise<void>;
  let directory: AccountDirectory;
  const writes: string[] = [];
  let memoryThrows = false;

  before(async () => {
    mongod = await MongoMemoryReplSet.create({
      binary: { version: "7.0.14" },
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await connectMongo(mongod.getUri());
    await PurchaseRecord.createIndexes();
    const inner = new InMemoryBackboardClient();
    const client: BackboardClient = {
      createAssistant: (input) => inner.createAssistant(input),
      addMemory: async (assistantId, input) => {
        if (memoryThrows) {
          throw new Error("Backboard down");
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
    directory = memory.directory;
    const app = express();
    app.use(express.json());
    attachAccounts(app, {
      jwtSecret: SECRET,
      directory: memory.directory,
      memory,
      provision: provisionAssistant(client, memory.directory),
    });
    const accountRoutes = {
      authenticate: requireUser(SECRET),
      directory: memory.directory,
      client,
      remote: true,
    };
    app.use("/purchases", createPurchaseRouter(accountRoutes));
    app.use("/onboarding", createOnboardingRouter(accountRoutes));
    app.use("/settings", createSettingsRouter(accountRoutes));
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

  it("saves the survey once, records the purchases you entered, and writes budget lines", async () => {
    const ada = await signup("ada-survey@example.com");
    assert.equal(typeof ada.token, "string");
    const before = await get("/purchases/history", ada.token);
    assert.deepEqual(before.body.purchases, []);
    assert.equal(await PurchaseRecord.countDocuments({ userId: ada.id, isExample: true }), 0);

    const started = writes.length;
    const saved = await post(
      "/onboarding/survey",
      {
        hourlyRate: 42,
        weeklyBudget: 150,
        recentPurchases: [
          { item: "AirPods", price: 179, regretted: true },
          { item: "USB-C Charge Cable", price: 19, regretted: false },
        ],
      },
      ada.token,
    );
    assert.equal(saved.status, 201);
    const body = saved.body as {
      completed: boolean;
      hourlyRate: number;
      weeklyBudget: number;
      purchases: { item: string; feedback: string; isExample: boolean; source: string; verdict: string | null }[];
    };
    assert.equal(body.completed, true);
    assert.equal(body.hourlyRate, 42);
    assert.equal(body.weeklyBudget, 150);
    assert.equal(body.purchases[0]?.feedback, "regretted");
    assert.equal(body.purchases[1]?.feedback, "kept");
    assert.equal(body.purchases.every((row) => row.isExample === false && row.source === "survey" && row.verdict === null), true);
    assert.equal(writes.includes(budgetMemoryLine("hourly rate", 42)), true);
    assert.equal(writes.includes(budgetMemoryLine("weekly budget", 150)), true);
    assert.equal(writes.includes(purchaseVoteLine("regretted", "AirPods", "audio", 179)), true);
    assert.equal(writes.filter((line) => line.startsWith("kept purchase:")).length, 0);
    assert.equal(writes.length, started + 3);

    const again = await post("/onboarding/survey", { hourlyRate: 1, weeklyBudget: 1, recentPurchases: [] }, ada.token);
    assert.equal(again.status, 409);
    const current = await get("/onboarding/survey", ada.token);
    assert.deepEqual(current.body, { completed: true, hourlyRate: 42, weeklyBudget: 150 });

    const history = await get("/purchases/history", ada.token);
    const rows = history.body.purchases as { item: string; isExample: boolean; feedback: string }[];
    assert.deepEqual(
      rows.map((row) => row.item).sort(),
      ["AirPods", "USB-C Charge Cable"],
    );
    assert.equal(rows.every((row) => row.isExample === false), true);
    assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 42, weeklyBudget: 150 });
    assert.equal(await getHourlyRate(ada.id), 42);
    assert.equal(await getWeeklyBudget(ada.id), 150);
  });

  it("hides example rows after an empty survey and isolates helpers", async () => {
    const ada = await signup("ada-empty@example.com");
    const blake = await signup("blake-empty@example.com");
    const saved = await post("/onboarding/survey", { hourlyRate: null, weeklyBudget: 80, recentPurchases: [] }, ada.token);
    assert.equal(saved.status, 201);
    const history = await get("/purchases/history", ada.token);
    assert.deepEqual(history.body.purchases, []);
    assert.equal(writes.includes(budgetMemoryLine("weekly budget", 80)), true);
    assert.equal(writes.includes(budgetMemoryLine("hourly rate", 0)), false);

    const blakeSurvey = await get("/onboarding/survey", blake.token);
    assert.deepEqual(blakeSurvey.body, { completed: false, hourlyRate: null, weeklyBudget: null });
    assert.equal(await getHourlyRate(blake.id), null);
    assert.equal(await getWeeklyBudget(blake.id), null);
    const stored = await User.findById(ada.id);
    assert.equal(stored?.surveyCompleted, true);
    assert.equal(stored?.hourlyRate, null);
  });

  it("records a bearer purchase in history and refuses a client user id", async () => {
    const ada = await signup("ada-buy@example.com");
    const blake = await signup("blake-buy@example.com");
    const foreign = await post(
      "/purchases",
      { userId: blake.id, item: "iPhone 16", category: "phone", price: 799, verdict: "unlock" },
      ada.token,
    );
    assert.equal(foreign.status, 400);

    const created = await post("/purchases", { item: "iPhone 16", category: "phone", price: 799, verdict: null }, ada.token);
    assert.equal(created.status, 201);
    const purchase = created.body.purchase as { feedback: null; isExample: boolean; verdict: null; price: number; item: string };
    assert.equal(purchase.feedback, null);
    assert.equal(purchase.isExample, false);
    assert.equal(purchase.verdict, null);
    assert.equal(purchase.price, 799);

    await PurchaseRecord.create({
      userId: ada.id,
      item: "Old cable",
      category: "cable",
      price: 100,
      verdict: "unlock",
      feedback: null,
      isExample: false,
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    await PurchaseRecord.create({
      userId: blake.id,
      item: "Blake phone",
      category: "phone",
      price: 50,
      verdict: "unlock",
      feedback: null,
      isExample: false,
    });

    const history = await get("/purchases/history", ada.token);
    const items = (history.body.purchases as { item: string; isExample: boolean }[]).map((row) => row.item);
    assert.equal(items.includes("iPhone 16"), true);
    assert.equal(items.includes("Blake phone"), false);
    assert.equal((history.body.purchases as { isExample: boolean }[]).every((row) => row.isExample === false), true);
    assert.equal(await weeklySpend(ada.id), 799);
    assert.equal(await weeklySpend(blake.id), 50);
    assert.deepEqual(await getBudgetProfile(blake.id), { hourlyRate: null, weeklyBudget: null });
  });

  it("rejects missing and bad tokens on survey and purchase routes", async () => {
    for (const path of ["/onboarding/survey", "/purchases/history", "/purchases"]) {
      const missing = await fetch(`${base}${path}`, { method: path.endsWith("/purchases") ? "POST" : "GET" });
      assert.equal(missing.status, 401);
      const bad = await fetch(`${base}${path}`, {
        method: path.endsWith("/purchases") ? "POST" : "GET",
        headers: { authorization: "Bearer not-a-jwt", "content-type": "application/json" },
        body: path.endsWith("/purchases") ? "{}" : undefined,
      });
      assert.equal(bad.status, 401);
    }
    const badSurvey = await fetch(`${base}/onboarding/survey`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-jwt", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(badSurvey.status, 401);
  });

  it("accepts zero and decimals, and rejects negative, huge, and a sixth purchase", async () => {
    const ada = await signup("ada-money@example.com");
    const zero = await post("/onboarding/survey", { hourlyRate: 0, weeklyBudget: 19.99, recentPurchases: [] }, ada.token);
    assert.equal(zero.status, 201);
    assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 0, weeklyBudget: 19.99 });
    assert.equal(writes.includes(budgetMemoryLine("hourly rate", 0)), true);
    assert.equal(writes.includes(budgetMemoryLine("weekly budget", 19.99)), true);

    const blake = await signup("blake-money@example.com");
    const negative = await post("/onboarding/survey", { hourlyRate: -1, weeklyBudget: 10, recentPurchases: [] }, blake.token);
    assert.equal(negative.status, 400);
    const huge = await post("/onboarding/survey", { hourlyRate: 10_000_000.01, weeklyBudget: 10, recentPurchases: [] }, blake.token);
    assert.equal(huge.status, 400);
    const five = Array.from({ length: 5 }, (_, index) => ({ item: `Item ${index}`, price: index + 0.5, regretted: false }));
    const capped = await post("/onboarding/survey", { hourlyRate: 12.5, weeklyBudget: null, recentPurchases: five }, blake.token);
    assert.equal(capped.status, 201);
    const sixth = await signup("cara-money@example.com");
    const tooMany = [...five, { item: "Extra", price: 1, regretted: true }];
    const rejected = await post("/onboarding/survey", { hourlyRate: 1, weeklyBudget: 1, recentPurchases: tooMany }, sixth.token);
    assert.equal(rejected.status, 400);
    assert.equal((await get("/onboarding/survey", sixth.token)).body.completed, false);
  });

  it("lets only one of two parallel submits win", async () => {
    const ada = await signup("ada-race@example.com");
    const body = { hourlyRate: 30, weeklyBudget: 40, recentPurchases: [{ item: "Watch", price: 399, regretted: true }] };
    const [left, right] = await Promise.all([
      post("/onboarding/survey", body, ada.token),
      post("/onboarding/survey", body, ada.token),
    ]);
    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const rows = await PurchaseRecord.find({ userId: ada.id, isExample: false });
    assert.equal(rows.length, 1);
    assert.equal(await surveyCompleted(ada.id), true);
  });

  it("counts regrets with and without a category, and returns no saved goals yet", async () => {
    const ada = await signup("ada-count@example.com");
    const blake = await signup("blake-count@example.com");
    await PurchaseRecord.create([
      { userId: ada.id, item: "Phone", category: "phone", price: 10, feedback: "regretted", isExample: false },
      { userId: ada.id, item: "Case", category: "case", price: 5, feedback: "regretted", isExample: false },
      { userId: ada.id, item: "Cable", category: "cable", price: 2, feedback: "kept", isExample: false },
      { userId: ada.id, item: "Demo phone", category: "phone", price: 1, feedback: "regretted", isExample: true },
      { userId: ada.id, item: "Demo buds", category: "audio", price: 1, feedback: "regretted", isExample: true },
      { userId: blake.id, item: "Watch", category: "watch", price: 3, feedback: "regretted", isExample: false },
    ]);
    assert.equal(await countRegrets(ada.id), 2);
    assert.equal(await countRegrets(ada.id, "phone"), 1);
    assert.equal(await countRegrets(ada.id, "watch"), 0);
    assert.equal(await countRegrets(blake.id), 1);
    assert.equal(await hasRegrettedPurchase(ada.id, "phone"), true);
    assert.equal(await hasRegrettedPurchase(ada.id, "audio"), false);
    assert.equal(await countRegrets(ada.id, "audio"), 0);
    assert.deepEqual(await getSavedGoals(ada.id), []);
  });

  it("saves the survey when a Backboard write throws and 404s a missing user", async () => {
    const ada = await signup("ada-memory-down@example.com");
    memoryThrows = true;
    try {
      const saved = await post(
        "/onboarding/survey",
        { hourlyRate: 20, weeklyBudget: 40, recentPurchases: [{ item: "AirPods", price: 179, regretted: true }] },
        ada.token,
      );
      assert.equal(saved.status, 201);
      const body = saved.body as { completed: boolean; hourlyRate: number; purchases: { item: string }[] };
      assert.equal(body.completed, true);
      assert.equal(body.hourlyRate, 20);
      assert.equal(body.purchases[0]?.item, "AirPods");
      assert.equal(await surveyCompleted(ada.id), true);
    } finally {
      memoryThrows = false;
    }

    const gone = await signup("ada-gone@example.com");
    await User.deleteOne({ _id: gone.id });
    const missing = await post("/onboarding/survey", { hourlyRate: 1, weeklyBudget: 1, recentPurchases: [] }, gone.token);
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error: string }).error, "User not found.");
  });

  it("rejects a Backboard write that never completes", async () => {
    const ada = await signup("ada-memory@example.com");
    const stalled: BackboardClient = {
      createAssistant: async (input) => ({ assistantId: `asst-${input.name.length}` }),
      addMemory: async () => ({ memoryId: null, operationId: null, status: "IN_PROGRESS" }),
      getMemoryOperation: async () => ({ status: "IN_PROGRESS", memoryIds: [] }),
      searchMemories: async () => [],
      sendMessage: async () => {
        throw new Error("sendMessage should not run");
      },
      resetMemories: async () => undefined,
    };
    await assert.rejects(
      () => writeUserMemoryLine(ada.id, budgetMemoryLine("hourly rate", 1), "goal", { directory, client: stalled, remote: false }),
      /Backboard memory write failed/,
    );
  });

  it("reads and updates settings, writes memory, and reflects the edit in the budget profile", async () => {
    const ada = await signup("ada-settings@example.com");
    const open = await fetch(`${base}/settings`);
    assert.equal(open.status, 401);
    const forged = await fetch(`${base}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-token" },
      body: JSON.stringify({ hourlyRate: 10 }),
    });
    assert.equal(forged.status, 401);

    const initial = await get("/settings", ada.token);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { hourlyRate: null, weeklyBudget: null });

    const started = writes.length;
    const saved = await patch("/settings", { hourlyRate: 55, weeklyBudget: 200 }, ada.token);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { hourlyRate: 55, weeklyBudget: 200 });
    assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 55, weeklyBudget: 200 });
    assert.equal(writes.includes(budgetMemoryLine("hourly rate", 55)), true);
    assert.equal(writes.includes(budgetMemoryLine("weekly budget", 200)), true);
    assert.equal(writes.length, started + 2);

    const onlyWeekly = await patch("/settings", { weeklyBudget: 90 }, ada.token);
    assert.equal(onlyWeekly.status, 200);
    assert.deepEqual(onlyWeekly.body, { hourlyRate: 55, weeklyBudget: 90 });
    assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 55, weeklyBudget: 90 });
    assert.equal(writes.includes(budgetMemoryLine("weekly budget", 90)), true);

    const current = await get("/settings", ada.token);
    assert.deepEqual(current.body, { hourlyRate: 55, weeklyBudget: 90 });
  });

  it("rejects settings that are not positive numbers and leaves the profile alone", async () => {
    const ada = await signup("ada-settings-bad@example.com");
    await patch("/settings", { hourlyRate: 40 }, ada.token);
    const invalid: unknown[] = [
      {},
      { hourlyRate: 0 },
      { hourlyRate: -5 },
      { weeklyBudget: 0 },
      { hourlyRate: "40" },
      { weeklyBudget: null },
      { hourlyRate: Number.POSITIVE_INFINITY },
    ];
    for (const body of invalid) {
      const response = await patch("/settings", body, ada.token);
      assert.equal(response.status, 400);
      const message = String(response.body.error ?? "");
      assert.equal(message.includes("hourlyRate"), false);
      assert.equal(message.includes("weeklyBudget"), false);
    }
    assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 40, weeklyBudget: null });
    const foreign = await patch("/settings", { userId: "someone-else", hourlyRate: 12 }, ada.token);
    assert.equal(foreign.status, 400);
    assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 40, weeklyBudget: null });

    assert.equal(positiveSettingsAmount(Number.NaN), null);
    assert.equal(positiveSettingsAmount(Number.POSITIVE_INFINITY), null);
    assert.equal(positiveSettingsAmount(Number.NEGATIVE_INFINITY), null);
    assert.equal(positiveSettingsAmount(10_000_000), 10_000_000);
    assert.equal(positiveSettingsAmount(10_000_000.01), null);
    for (const body of [{ hourlyRate: "NaN" }, { hourlyRate: "Infinity" }]) {
      const response = await patch("/settings", body, ada.token);
      assert.equal(response.status, 400);
    }
    const cap = await patch("/settings", { hourlyRate: 10_000_000 }, ada.token);
    assert.equal(cap.status, 200);
    assert.equal((await getBudgetProfile(ada.id)).hourlyRate, 10_000_000);
    const over = await patch("/settings", { hourlyRate: 10_000_000.01 }, ada.token);
    assert.equal(over.status, 400);
    assert.equal((await getBudgetProfile(ada.id)).hourlyRate, 10_000_000);
  });

  it("saves one settings field when the other is missing or zero, and keeps the save if memory fails", async () => {
    const ada = await signup("ada-settings-one@example.com");
    await User.updateOne({ _id: ada.id }, { $set: { hourlyRate: null, weeklyBudget: 0 } });
    const started = writes.length;
    const saved = await patch("/settings", { hourlyRate: 18 }, ada.token);
    assert.equal(saved.status, 200);
    assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 18, weeklyBudget: 0 });
    assert.equal(writes.includes(budgetMemoryLine("hourly rate", 18)), true);
    assert.equal(writes.slice(started).some((line) => line.startsWith("weekly budget:")), false);

    memoryThrows = true;
    try {
      const kept = await patch("/settings", { weeklyBudget: 25 }, ada.token);
      assert.equal(kept.status, 200);
      assert.deepEqual(await getBudgetProfile(ada.id), { hourlyRate: 18, weeklyBudget: 25 });
    } finally {
      memoryThrows = false;
    }

    await User.deleteOne({ _id: ada.id });
    const gone = await patch("/settings", { hourlyRate: 9 }, ada.token);
    assert.equal(gone.status, 404);
  });
});

async function surveyCompleted(userId: string): Promise<boolean> {
  const user = await User.findById(userId);
  return user?.surveyCompleted === true;
}

async function signup(email: string): Promise<{ id: string; token: string }> {
  const response = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  const body = (await response.json()) as { user: { id: string }; token: string };
  const cookie = readCookie(response);
  assert.ok(cookie);
  assert.equal(typeof body.token, "string");
  const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200);
  return { id: body.user.id, token: body.token };
}

async function get(path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function patch(path: string, body: unknown, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function post(path: string, body: unknown, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
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
