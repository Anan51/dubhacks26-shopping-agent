import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { connectMongo } from "../auth/db.js";
import { User } from "../auth/user.js";
import { itemsForBag, startLockedCart } from "../carts.js";
import type { BackboardClient, MemorySearchHit } from "../memory/backboard.js";
import { categoryForItem } from "../purchases/service.js";
import type { Cart, CartItem } from "../types.js";
import { computeImpulseScore } from "./backboardScore.js";
import { applyImpulseReading, readingForCart, type CartReading } from "./cartReading.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const LATER = new Date("2026-10-19T00:00:00.000Z");

function bag(): Cart {
  const cart = startLockedCart({
    items: itemsForBag(["Example phone"], 120_000, true),
    totalCents: 120_000,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: "user-low|120000|example phone",
    now: NOW,
    demo: true,
    lockMs: 600_000,
    userId: "user-low",
    code: "LOWBAG",
  });
  cart.necessity = "unnecessary";
  return cart;
}

function reading(score: number, band: "free" | "soft" | "strict"): CartReading {
  const legacyImpulse = band === "free" ? 4 : band === "soft" ? 2 : 1;
  return {
    impulse: { score1to8: score, band, why: null },
    hoursOfWork: { hours: 10, hourlyRate: 20 },
    hoursOfWorkText: "This is about 10 hours of work at $20/hr.",
    legacyImpulse,
  };
}

describe("impulse lock", () => {
  it("leaves an unnecessary bag locked when the score is 3 or lower", () => {
    const cart = bag();
    applyImpulseReading(cart, reading(3, "free"), NOW, 60_000, "create");
    assert.equal(cart.impulse?.score1to8, 3);
    assert.equal(cart.impulse?.band, "free");
    assert.equal(cart.hoursOfWork?.hours, 10);
    assert.equal(cart.isUnlocked, false);
    assert.equal(cart.status, "locked");
    assert.equal(cart.vaultUntil, null);
  });

  it("does not vault, relock, or touch reminders when a refresh score is 6–8", () => {
    const cart = bag();
    applyImpulseReading(cart, reading(4.5, "soft"), NOW, 60_000, "create");
    assert.equal(cart.status, "locked");
    assert.equal(cart.vaultUntil, null);
    const before = {
      status: cart.status,
      isUnlocked: cart.isUnlocked,
      vaultUntil: cart.vaultUntil,
      vaultMode: cart.vaultMode,
      reminderAt: cart.reminderAt,
      reminderFireAt: cart.reminderFireAt,
      reminderSentAt: cart.reminderSentAt,
      lockEndsAt: cart.lockEndsAt,
      userImpulseScore: cart.userImpulseScore,
    };

    applyImpulseReading(cart, reading(7, "strict"), LATER, 60_000, "refresh");
    assert.equal(cart.impulse?.score1to8, 7);
    assert.equal(cart.impulse?.band, "strict");
    assert.equal(cart.hoursOfWork?.hours, 10);
    assert.deepEqual(
      {
        status: cart.status,
        isUnlocked: cart.isUnlocked,
        vaultUntil: cart.vaultUntil,
        vaultMode: cart.vaultMode,
        reminderAt: cart.reminderAt,
        reminderFireAt: cart.reminderFireAt,
        reminderSentAt: cart.reminderSentAt,
        lockEndsAt: cart.lockEndsAt,
        userImpulseScore: cart.userImpulseScore,
      },
      before,
    );
  });
});

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PHONE_REGRET = "You regretted a similar purchase before.";

describe("mixed bag impulse item", { concurrency: false }, () => {
  let mongod: MongoMemoryServer;
  let userId: string;

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
    const user = await User.create({
      email: "mixed-bag-score@example.com",
      passwordHash: HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-mixed-bag",
    });
    userId = user.id;
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("gives a cable-first iPhone bag the same phone-regret boost as an iPhone-only bag", async () => {
    const options = regretOptions();
    const mixed = pricedCart(
      [
        line("USB-C Charge Cable", 1_900),
        line("iPhone 16", 99_900),
      ],
      4_000,
    );
    const phoneOnly = pricedCart([line("iPhone 16", 99_900)], 4_000);

    const mixedReading = await readingForCart(userId, mixed, options);
    const phoneReading = await readingForCart(userId, phoneOnly, options);

    assert.deepEqual(mixedReading.impulse, phoneReading.impulse);
    assert.ok(mixedReading.impulse.score1to8 > 4.5);
    assert.equal(mixedReading.impulse.why, PHONE_REGRET);
  });

  it("scores a single-item bag from that item and the bag total", async () => {
    const options = regretOptions();
    const cart = pricedCart([line("iPhone 16", 99_900)], 4_000);
    const reading = await readingForCart(userId, cart, options);
    const direct = await computeImpulseScore(
      userId,
      {
        item: cart.items[0]?.name ?? "Apple bag",
        category: categoryForItem(cart.items[0]?.name ?? ""),
        price: cart.totalCents / 100,
        necessary: cart.necessity === "necessary",
      },
      undefined,
      options,
    );

    assert.equal(reading.impulse.score1to8, direct.score);
    assert.equal(reading.impulse.why, direct.why);
    assert.equal(reading.impulse.why, PHONE_REGRET);
    assert.equal(reading.hoursOfWork, null);
    assert.ok(reading.impulse.score1to8 > 4.5);
  });

  it("scores an itemsForBag cable plus iPhone from the iPhone at the bag total", async () => {
    const totalCents = 4_000;
    const cart = bagFromNames(["Lightning cable", "iPhone 16 Pro"], totalCents);
    assert.deepEqual(
      cart.items.map((item) => ({ name: item.name, priceCents: item.priceCents })),
      [
        { name: "Lightning cable", priceCents: totalCents },
        { name: "iPhone 16 Pro", priceCents: 0 },
      ],
    );

    const queries: string[] = [];
    const reading = await readingForCart(userId, cart, regretOptions(queries));
    const phoneOnly = await readingForCart(userId, bagFromNames(["iPhone 16 Pro"], totalCents), regretOptions());
    const direct = await scoredDirect(userId, "iPhone 16 Pro", totalCents);

    assert.equal(queries[0], "iPhone 16 Pro phone");
    assert.deepEqual(reading.impulse, phoneOnly.impulse);
    assert.equal(reading.impulse.score1to8, direct.score);
    assert.equal(reading.impulse.why, direct.why);
    assert.equal(reading.impulse.why, PHONE_REGRET);
    assert.ok(reading.impulse.score1to8 > 4.5);
    assert.equal(reading.hoursOfWork, null);
  });

  it("scores an itemsForBag AirPods plus iPhone from the iPhone, not the total line", async () => {
    const totalCents = 4_000;
    const cart = bagFromNames(["AirPods Pro", "iPhone 16 Pro"], totalCents);
    assert.equal(cart.items[0]?.name, "AirPods Pro");
    assert.equal(cart.items[0]?.priceCents, totalCents);
    assert.equal(cart.items[1]?.priceCents, 0);

    const queries: string[] = [];
    const reading = await readingForCart(userId, cart, regretOptions(queries));
    const phoneOnly = await readingForCart(userId, bagFromNames(["iPhone 16 Pro"], totalCents), regretOptions());

    assert.equal(queries[0], "iPhone 16 Pro phone");
    assert.deepEqual(reading.impulse, phoneOnly.impulse);
    assert.equal(reading.impulse.why, PHONE_REGRET);
    assert.ok(reading.impulse.score1to8 > 4.5);
    assert.equal(reading.hoursOfWork, null);
  });

  it("keeps the priciest unnecessary line when each item has its own price", async () => {
    const queries: string[] = [];
    const cart = pricedCart([line("AirPods Pro", 20_000), line("iPhone 16 Pro", 10_000)], 4_000);
    const reading = await readingForCart(userId, cart, regretOptions(queries));

    assert.equal(queries[0], "AirPods Pro audio");
    assert.equal(reading.impulse.score1to8, 4.5);
    assert.equal(reading.impulse.why, null);
    assert.equal(reading.hoursOfWork, null);
  });

  it("scores the first unnecessary name when an itemsForBag has no phone", async () => {
    const queries: string[] = [];
    const cart = bagFromNames(["USB-C charger", "Headphones"], 4_000);
    const reading = await readingForCart(userId, cart, regretOptions(queries));

    assert.equal(cart.items[0]?.priceCents, 4_000);
    assert.equal(cart.items[1]?.priceCents, 0);
    assert.equal(queries[0], "Headphones audio");
    assert.equal(reading.impulse.score1to8, 4.5);
    assert.equal(reading.impulse.why, null);
  });

  it("falls back to the first itemsForBag line when every name is necessary", async () => {
    const queries: string[] = [];
    const cart = bagFromNames(["Lightning cable", "20W USB-C Power Adapter"], 4_000);
    const reading = await readingForCart(userId, cart, regretOptions(queries));

    assert.equal(queries[0], "Lightning cable cable");
    assert.equal(reading.impulse.score1to8, 4.5);
    assert.equal(reading.impulse.why, null);
  });
});

function regretOptions(queries?: string[]) {
  return {
    backboardEnabled: true as const,
    client: scriptedClient(async (_assistantId, query) => {
      queries?.push(query);
      return [hit("regretted purchase: iPhone 16 (phone, $999)", 0.2)];
    }),
  };
}

function bagFromNames(names: readonly string[], totalCents: number): Cart {
  return pricedCart(itemsForBag(names, totalCents, true), totalCents);
}

async function scoredDirect(userId: string, item: string, totalCents: number) {
  return computeImpulseScore(
    userId,
    {
      item,
      category: categoryForItem(item),
      price: totalCents / 100,
      necessary: false,
    },
    undefined,
    regretOptions(),
  );
}

function pricedCart(items: CartItem[], totalCents: number): Cart {
  const cart = startLockedCart({
    items,
    totalCents,
    parsedFromPage: true,
    pageHost: "www.apple.com",
    fingerprint: `mix|${totalCents}|${items.map((item) => item.name.toLowerCase()).join("|")}`,
    now: NOW,
    demo: true,
    lockMs: 600_000,
    userId: "user-mix",
  });
  cart.necessity = "unnecessary";
  return cart;
}

function line(name: string, priceCents: number): CartItem {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    kind: "accessory",
    name,
    detail: "Read from the Apple bag",
    priceCents,
    cadence: "once",
  };
}

function hit(content: string, score: number): MemorySearchHit {
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
