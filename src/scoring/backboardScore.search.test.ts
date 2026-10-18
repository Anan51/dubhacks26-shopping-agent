import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { mongooseDirectory } from "../auth/accounts.js";
import { itemsForBag, startLockedCart } from "../carts.js";
import { connectMongo } from "../auth/db.js";
import { MemoryNote, User } from "../auth/user.js";
import { InMemoryBackboardClient, type BackboardClient, type MemorySearchHit } from "../memory/backboard.js";
import { PurchaseRecord } from "../purchases/model.js";
import { categoryForItem, insertRealPurchase, purchaseVoteLine, setPurchaseFeedback, writeUserMemoryLine } from "../purchases/service.js";
import {
  computeImpulseScore,
  REGRET_SEARCH_LIMIT,
  REGRET_SEARCH_TIMEOUT_MS,
  regretSearchQuery,
  type ImpulseItem,
} from "./backboardScore.js";
import { readingForCart } from "./cartReading.js";

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const buds: ImpulseItem = { item: "AirPods", category: "audio", price: 40, necessary: false };

describe("regret search scoring", { concurrency: false }, () => {
  let mongod: MongoMemoryServer;
  let bench: InMemoryBackboardClient;

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
    bench = new InMemoryBackboardClient();
    await bench.createAssistant({ name: "reserved", systemPrompt: "unused" });
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
    hits = [hit("regretted purchase: AirPods (audio, $179)", 0.55)];
    const farther = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client });
    hits = [hit("regretted purchase: AirPods (audio, $179)", 0.1)];
    const closer = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client });
    assert.ok(farther.score > 4.5);
    assert.ok(closer.score > farther.score);
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

  it("scores a kept flip the same as a purchase that was never regretted", async () => {
    const client = bench;
    const directory = mongooseDirectory();
    const deps = { directory, client, remote: true as const };
    const steadyAssistant = await reserveAssistant(bench, "steady");
    const steady = await User.create({
      email: "steady-kept@example.com",
      passwordHash: HASH,
      weeklyBudget: 500,
      backboardAssistantId: steadyAssistant,
    });
    const steadyPurchase = await insertRealPurchase({
      userId: steady.id,
      item: "AirPods",
      category: "audio",
      price: 179,
      verdict: null,
      feedback: null,
    });
    await setPurchaseFeedback(steady.id, steadyPurchase._id, "kept", deps);

    const shopperAssistant = await reserveAssistant(bench, "flipped");
    const shopper = await User.create({
      email: "flipped-kept@example.com",
      passwordHash: HASH,
      weeklyBudget: 500,
      backboardAssistantId: shopperAssistant,
    });
    const purchase = await insertRealPurchase({
      userId: shopper.id,
      item: "AirPods",
      category: "audio",
      price: 179,
      verdict: null,
      feedback: null,
    });
    await setPurchaseFeedback(shopper.id, purchase._id, "regretted", deps);
    const during = await computeImpulseScore(shopper.id, buds, undefined, { backboardEnabled: true, client });
    assert.ok(during.score > 4.5);
    await setPurchaseFeedback(shopper.id, purchase._id, "kept", deps);

    const afterFlip = await computeImpulseScore(shopper.id, buds, undefined, { backboardEnabled: true, client });
    const neverRegretted = await computeImpulseScore(steady.id, buds, undefined, { backboardEnabled: true, client });
    assert.equal(afterFlip.score, neverRegretted.score);
    assert.equal(afterFlip.score, 4.5);
    assert.equal(afterFlip.why, null);
  });

  it("keeps one regret memory when a vote goes regretted, kept, then regretted", async () => {
    const client = bench;
    const directory = mongooseDirectory();
    const ada = await User.create({
      email: "cycle-regret@example.com",
      passwordHash: HASH,
      weeklyBudget: 500,
      backboardAssistantId: await reserveAssistant(bench, "cycle"),
    });
    const purchase = await insertRealPurchase({
      userId: ada.id,
      item: "AirPods",
      category: "audio",
      price: 179,
      verdict: null,
      feedback: null,
    });
    const deps = { directory, client, remote: true as const };
    await setPurchaseFeedback(ada.id, purchase._id, "regretted", deps);
    await setPurchaseFeedback(ada.id, purchase._id, "kept", deps);
    await setPurchaseFeedback(ada.id, purchase._id, "regretted", deps);

    assert.equal(await MemoryNote.countDocuments({ userId: ada.id, "meta.purchaseId": purchase._id }), 1);
    assert.equal(await MemoryNote.countDocuments({ userId: ada.id, type: "regret", "meta.purchaseId": purchase._id }), 1);
    const account = await directory.findById(ada.id);
    const hits = await client.searchMemories(account?.backboardAssistantId ?? "", regretSearchQuery(buds.item, buds.category), REGRET_SEARCH_LIMIT);
    assert.equal(hits.filter((hit) => hit.content.includes("regretted purchase:")).length, 1);
  });

  it("ignores a regret hit past the max distance and counts one on it", async () => {
    const ada = await User.create({
      email: "search-floor@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-floor",
    });
    const previous = process.env.REGRET_SEARCH_MAX_DISTANCE;
    delete process.env.REGRET_SEARCH_MAX_DISTANCE;
    try {
      const past = scriptedClient(async () => [hit("regretted purchase: AirPods (audio, $179)", 0.9)]);
      const ignored = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client: past });
      assert.equal(ignored.score, 4.5);
      assert.equal(ignored.why, null);

      const onMax = scriptedClient(async () => [hit("regretted purchase: AirPods (audio, $179)", 0.7)]);
      const counted = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client: onMax });
      assert.ok(counted.score > 4.5);

      const near = scriptedClient(async () => [hit("regretted purchase: AirPods (audio, $179)", 0.44)]);
      const raised = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client: near });
      assert.ok(raised.score > counted.score);

      process.env.REGRET_SEARCH_MAX_DISTANCE = "0.4";
      const pastKnob = scriptedClient(async () => [hit("regretted purchase: AirPods (audio, $179)", 0.44)]);
      const held = await computeImpulseScore(ada.id, buds, undefined, { backboardEnabled: true, client: pastKnob });
      assert.equal(held.score, 4.5);
    } finally {
      if (previous === undefined) {
        delete process.env.REGRET_SEARCH_MAX_DISTANCE;
      } else {
        process.env.REGRET_SEARCH_MAX_DISTANCE = previous;
      }
    }
  });

  it("raises a close same-category regret and ignores a far or cross-category hit", async () => {
    const ada = await User.create({
      email: "search-category@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-category",
    });
    const phoneNear = hit("regretted purchase: iPhone (phone, $999)", 0.44);
    const phoneFar = hit("regretted purchase: iPhone (phone, $999)", 0.905);
    const phone: ImpulseItem = { item: "iPhone", category: "phone", price: 40, necessary: false };
    const socks: ImpulseItem = { item: "wool socks", category: "other", price: 12, necessary: false };
    const mug: ImpulseItem = { item: "ceramic mug", category: "other", price: 18, necessary: false };
    const hikingSocks: ImpulseItem = { item: "wool hiking socks", category: "other", price: 16, necessary: false };
    const macbook: ImpulseItem = { item: "MacBook Air", category: "computer", price: 40, necessary: false };

    const same = await computeImpulseScore(ada.id, phone, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [phoneNear]),
    });
    assert.ok(same.score > 4.5);
    assert.equal(same.why, "You regretted a similar purchase before.");

    const far = await computeImpulseScore(ada.id, phone, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [phoneFar]),
    });
    assert.equal(far.score, 4.5);
    assert.equal(far.why, null);

    const cross = await computeImpulseScore(ada.id, socks, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [phoneNear]),
    });
    assert.equal(cross.score, 4.5);
    assert.equal(cross.why, null);

    const socksRegret = hit("regretted purchase: wool socks (other, $12)", 0.2);
    const unrelatedOther = await computeImpulseScore(ada.id, mug, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [socksRegret]),
    });
    // Both names keyword to "other", so the name-derived categories are equal.
    assert.ok(unrelatedOther.score > 4.5);
    assert.equal(unrelatedOther.why, "You regretted a similar purchase before.");

    const overlappingOther = await computeImpulseScore(ada.id, hikingSocks, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [socksRegret]),
    });
    assert.ok(overlappingOther.score > 4.5);
    assert.equal(overlappingOther.why, "You regretted a similar purchase before.");

    const sameSocks = await computeImpulseScore(ada.id, socks, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [hit("regretted purchase: wool socks (other, $12)", 0.44)]),
    });
    assert.ok(sameSocks.score > 4.5);

    const laptopRegret = hit("regretted purchase: laptop (computer, $1299)", 0.44);
    const macbookRaised = await computeImpulseScore(ada.id, macbook, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [laptopRegret]),
    });
    assert.ok(macbookRaised.score > 4.5);
    assert.equal(macbookRaised.why, "You regretted a similar purchase before.");

    const macbookCross = await computeImpulseScore(ada.id, macbook, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [socksRegret]),
    });
    assert.equal(macbookCross.score, 4.5);
  });

  it("keeps a necessary cart and a search with no hits at 4.5", async () => {
    const ada = await User.create({
      email: "search-demo-path@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-demo-path",
    });
    const pixel = hit("regretted purchase: Pixel 9 (phone, $799.00)", 0.44);
    const none = await scoreReadCart(ada.id, "Pixel 9", []);
    assert.equal(none.impulse.score1to8, 4.5);
    assert.equal(none.impulse.why, null);

    const necessary = await scoreReadCart(ada.id, "Pixel 9", [pixel], true);
    assert.equal(necessary.impulse.score1to8, 4.5);
    assert.equal(necessary.impulse.why, null);
  });

  it("drops Wool socks against a MacBook cart", async () => {
    const ada = await User.create({
      email: "search-socks-macbook@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-socks-macbook",
    });
    const socks = hit("regretted purchase: Wool socks (other, $12.00)", 0.44);
    const flat = await scoreReadCart(ada.id, "MacBook Air", [socks]);
    assert.equal(flat.impulse.score1to8, 4.5);
    assert.equal(flat.impulse.why, null);
  });

  it("scores a Pixel 9 cart from a phone regret whose name keywords to other", async () => {
    assert.equal(categoryForItem("Pixel 9"), "other");
    const ada = await User.create({
      email: "search-pixel@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-pixel",
    });
    const pixel = hit("regretted purchase: Pixel 9 (phone, $799.00)", 0.44);
    const raised = await scoreReadCart(ada.id, "Pixel 9", [pixel]);
    // 4.5 + 0.7 * (1 - 0.44) rounds to 4.9. The cart category is "other".
    assert.ok(raised.impulse.score1to8 > 4.5);
    assert.equal(raised.impulse.score1to8, 4.9);
    assert.equal(raised.impulse.why, "You regretted a similar purchase before.");
  });

  it("raises a Galaxy S24 cart from a Pixel phone regret without a shared name token", async () => {
    assert.equal(categoryForItem("Galaxy S24"), "other");
    assert.equal(categoryForItem("Pixel 9"), "other");
    const ada = await User.create({
      email: "search-galaxy@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-galaxy",
    });
    const pixel = hit("regretted purchase: Pixel 9 (phone, $799.00)", 0.44);
    const raised = await scoreReadCart(ada.id, "Galaxy S24", [pixel]);
    assert.ok(raised.impulse.score1to8 > 4.5);
    assert.equal(raised.impulse.score1to8, 4.9);
    assert.equal(raised.impulse.why, "You regretted a similar purchase before.");
  });

  it("counts a shared token on an other bag when the keyword categories differ", async () => {
    const ada = await User.create({
      email: "search-shared-token@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-shared-token",
    });
    const memory = hit("Regret: wool socks next to an iPhone", 0.44);
    assert.equal(categoryForItem("wool socks next to an iPhone"), "phone");
    const raised = await scoreReadCart(ada.id, "wool socks", [memory]);
    assert.ok(raised.impulse.score1to8 > 4.5);
    assert.equal(raised.impulse.score1to8, 4.9);
  });

  it("matches a MacBook cart to a regret saved under the apple category", async () => {
    const ada = await User.create({
      email: "search-apple-macbook@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-apple-macbook",
    });
    const saved = hit("regretted purchase: MacBook Air (apple, $999.00)", 0.44);
    const raised = await scoreReadCart(ada.id, "MacBook Air", [saved]);
    assert.ok(raised.impulse.score1to8 > 4.5);
    assert.equal(raised.impulse.score1to8, 4.9);
    assert.equal(raised.impulse.why, "You regretted a similar purchase before.");
  });

  it("falls back to the item name when the saved category is empty", async () => {
    const ada = await User.create({
      email: "search-empty-category@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-empty-category",
    });
    const empty = hit("regretted purchase: AirPods ( , $179.00)", 0.44);
    const audio = await scoreReadCart(ada.id, "AirPods", [empty]);
    assert.equal(audio.impulse.score1to8, 4.9);
    assert.equal(audio.impulse.why, "You regretted a similar purchase before.");

    const computer = await scoreReadCart(ada.id, "MacBook Air", [empty]);
    assert.equal(computer.impulse.score1to8, 4.5);
    assert.equal(computer.impulse.why, null);
  });

  it("maps a free-text Regret line with categoryForItem when no category is recorded", async () => {
    const ada = await User.create({
      email: "search-freetext@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-freetext",
    });
    const freeText = hit("Regret: iPhone 16 Pro", 0.44);
    const phone: ImpulseItem = { item: "iPhone", category: "phone", price: 40, necessary: false };
    const raised = await computeImpulseScore(ada.id, phone, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [freeText]),
    });
    assert.ok(raised.score > 4.5);
    assert.equal(raised.score, 4.9);
    assert.equal(raised.why, "You regretted a similar purchase before.");

    const keywordBag: ImpulseItem = { item: "iPhone", category: "  ", price: 40, necessary: false };
    const fromName = await computeImpulseScore(ada.id, keywordBag, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [freeText]),
    });
    assert.equal(fromName.score, 4.9);

    const unrecognized: ImpulseItem = { item: "Galaxy S24", category: "", price: 40, necessary: false };
    const missed = await computeImpulseScore(ada.id, unrecognized, undefined, {
      backboardEnabled: true,
      client: scriptedClient(async () => [freeText]),
    });
    assert.equal(missed.score, 4.5);
    assert.equal(missed.why, null);
  });

  it("falls back to 4.5 when the regret search times out", async () => {
    assert.equal(REGRET_SEARCH_TIMEOUT_MS, 3_500);
    const ada = await User.create({
      email: "search-timeout@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-timeout",
    });
    const hanging = scriptedClient(() => new Promise<MemorySearchHit[]>(() => undefined));
    const timed = await computeImpulseScore(ada.id, buds, undefined, {
      backboardEnabled: true,
      client: hanging,
      searchTimeoutMs: 30,
    });
    assert.equal(timed.score, 4.5);
    assert.equal(timed.why, null);
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

async function reserveAssistant(client: InMemoryBackboardClient, name: string): Promise<string> {
  const created = await client.createAssistant({ name: `Simmer ${name}`, systemPrompt: "Remember one shopper." });
  return created.assistantId;
}

function hit(content: string, score: number | null): MemorySearchHit {
  return { id: "mem", content, score, createdAt: null };
}

/** Cart total stays under the weekly budget so only a regret hit can move the score. */
async function scoreReadCart(userId: string, item: string, hits: MemorySearchHit[], necessary = false) {
  const totalCents = 4_000;
  const cart = startLockedCart({
    items: itemsForBag([item], totalCents, true),
    totalCents,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: `${userId}|${totalCents}|${item.toLowerCase()}`,
    now: new Date("2026-10-18T00:00:00.000Z"),
    demo: true,
    lockMs: 600_000,
    userId,
  });
  cart.necessity = necessary ? "necessary" : "unnecessary";
  return readingForCart(userId, cart, {
    backboardEnabled: true,
    client: scriptedClient(async () => hits),
  });
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
