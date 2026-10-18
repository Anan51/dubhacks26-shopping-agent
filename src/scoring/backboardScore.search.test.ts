import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { mongooseDirectory } from "../auth/accounts.js";
import { connectMongo } from "../auth/db.js";
import { User } from "../auth/user.js";
import { InMemoryBackboardClient, type BackboardClient, type MemorySearchHit } from "../memory/backboard.js";
import { PurchaseRecord } from "../purchases/model.js";
import { purchaseVoteLine, writeUserMemoryLine } from "../purchases/service.js";
import { computeImpulseScore, REGRET_SEARCH_LIMIT, regretSearchQuery, type ImpulseItem } from "./backboardScore.js";

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const buds: ImpulseItem = { item: "AirPods", category: "audio", price: 40, necessary: false };

describe("regret search scoring", { concurrency: false }, () => {
  let mongod: MongoMemoryServer;

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("finds a written regret and only raises an unnecessary bag", async () => {
    const client = new InMemoryBackboardClient();
    const directory = mongooseDirectory();
    const ada = await User.create({
      email: "search-ada@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
    });
    await writeUserMemoryLine(
      ada.id,
      purchaseVoteLine("regretted", "AirPods", "audio", 179),
      "regret",
      { directory, client, remote: true },
      { category: "audio", feedback: "regretted" },
    );
    const account = await directory.findById(ada.id);
    const assistantId = account?.backboardAssistantId ?? "";
    assert.ok(assistantId);
    const found = await client.searchMemories(assistantId, regretSearchQuery(buds.item, buds.category), REGRET_SEARCH_LIMIT);
    assert.equal(found.length, 1);
    assert.match(found[0]?.content ?? "", /regretted purchase: AirPods/);

    const scored = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client });
    assert.equal(scored.score, 5.2);
    assert.ok(scored.score > 4.5);
    assert.equal(scored.why, "You regretted a similar purchase before.");

    await writeUserMemoryLine(
      ada.id,
      purchaseVoteLine("regretted", "AirPods Max", "audio", 549),
      "regret",
      { directory, client, remote: true },
      { category: "audio", feedback: "regretted" },
    );
    const stricter = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client });
    assert.ok(stricter.score > scored.score);
    assert.ok(stricter.score <= 8);

    const necessary = await computeImpulseScore(
      ada.id,
      { ...buds, necessary: true, hours: 20 },
      undefined,
      { backboardEnabled: true, client },
    );
    assert.equal(necessary.score, 4.5);
    assert.equal(necessary.why, null);

    const unmatched = await computeImpulseScore(
      ada.id,
      { item: "Watch", category: "watch", price: 40, necessary: false },
      undefined,
      { backboardEnabled: true, client },
    );
    assert.equal(unmatched.score, 4.5);
    assert.equal(unmatched.why, null);

    const demo = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: false, client });
    assert.equal(demo.score, 4.5);
    assert.equal(demo.why, null);
  });

  it("does not let PurchaseRecords or a kept line move the score", async () => {
    const blake = await User.create({
      email: "search-blake@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-blake-kept",
    });
    const client = scriptedClient(async () => [
      hit("kept purchase: AirPods (audio, $179)", 0.99),
      hit("Goal: save for AirPods", 0.99),
    ]);
    await PurchaseRecord.create({
      userId: blake.id,
      item: "AirPods",
      category: "audio",
      price: 179,
      feedback: "regretted",
      isExample: false,
      source: "survey",
    });
    const scored = await computeImpulseScore(blake.id, buds, undefined, { backboardEnabled: true, client });
    assert.equal(scored.score, 4.5);
    assert.equal(scored.why, null);
  });

  it("weighs a closer hit more than a weak one and ignores a search failure", async () => {
    const ada = await User.create({
      email: "search-close@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-close",
    });
    let hits: MemorySearchHit[] = [];
    let calls = 0;
    const seen: { assistantId: string; query: string; limit: number }[] = [];
    const client = scriptedClient(async (assistantId, query, limit) => {
      calls += 1;
      seen.push({ assistantId, query, limit });
      return hits;
    });
    hits = [hit("regretted purchase: AirPods (audio, $179)", 0.3)];
    const weak = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client });
    hits = [hit("regretted purchase: AirPods (audio, $179)", 0.95)];
    const close = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client });
    assert.ok(weak.score > 4.5);
    assert.ok(close.score > weak.score);
    const last = seen.at(-1);
    assert.equal(last?.assistantId, "asst-close");
    assert.equal(last?.query, regretSearchQuery("AirPods", "audio"));
    assert.equal(last?.limit, REGRET_SEARCH_LIMIT);

    const failing = scriptedClient(async () => {
      throw new Error("Backboard down");
    });
    const failed = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client: failing });
    assert.equal(failed.score, 4.5);
    assert.equal(failed.why, null);

    const hanging = scriptedClient(() => new Promise<MemorySearchHit[]>(() => undefined));
    const timed = await computeImpulseScore(ada.id, buds, undefined, {
      backboardEnabled: true,
      client: hanging,
      searchTimeoutMs: 30,
    });
    assert.equal(timed.score, 4.5);
    assert.ok(calls >= 1);
  });

  it("leaves price and hours alone when the key is unset", async () => {
    const ada = await User.create({
      email: "search-demo@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 50,
      backboardAssistantId: "asst-demo",
    });
    let calls = 0;
    const client = scriptedClient(async () => {
      calls += 1;
      return [hit("regretted purchase: AirPods (audio, $179)", 0.99)];
    });
    const over = await computeImpulseScore(
      ada.id,
      { ...buds, price: 80 },
      undefined,
      { backboardEnabled: false, client },
    );
    assert.equal(over.score, 5);
    assert.equal(over.why, "This costs more than your weekly budget.");
    const hours = await computeImpulseScore(
      ada.id,
      { ...buds, hours: 9 },
      { weeklyBudget: 500 },
      { backboardEnabled: false, client },
    );
    assert.equal(hours.score, 4.9);
    assert.equal(calls, 0);
  });
});

function hit(content: string, score: number | null): MemorySearchHit {
  return { id: "mem", content, score, createdAt: null };
}

function scriptedClient(
  search: (assistantId: string, query: string, limit: number) => Promise<MemorySearchHit[]>,
): BackboardClient {
  return {
    async createAssistant() {
      return { assistantId: "asst-scripted" };
    },
    async addMemory() {
      return { memoryId: "mem", operationId: null, status: "COMPLETED" };
    },
    async getMemoryOperation() {
      return { status: "COMPLETED", memoryIds: [] };
    },
    searchMemories: search,
    async sendMessage() {
      throw new Error("sendMessage should not run");
    },
    async resetMemories() {
      return undefined;
    },
    async deleteMemory() {
      return undefined;
    },
  };
}
