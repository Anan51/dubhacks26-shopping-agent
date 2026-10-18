import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { connectMongo } from "./auth/db.js";
import { User } from "./auth/user.js";
import { createApp } from "./app.js";
import { InMemoryBackboardClient } from "./memory/backboard.js";
import { PurchaseRecord } from "./purchases/model.js";
import { purchaseVoteLine } from "./purchases/service.js";
import { holdForUnlock, isEnforcedVault, itemsForBag, liftCart, sleepCart, startLockedCart, unlockCart, withCartFacts } from "./carts.js";
import { CARRIER_PASS, CARRIER_WAIT, carrierSentence } from "./scoring/carrierSwitch.js";
import { createMemoryStore } from "./store.js";
import { decide } from "./heuristic.js";
import { DELIBERATE, IMPULSIVE, personaFor } from "./history.js";
import {
  applyPurchaseScore,
  classifyNecessity,
  syncFreeBandCopy,
  clampGrade,
  gradeJustification,
  keywordGrade,
  keywordNecessity,
  locksCheckout,
  parseGradeJson,
  purchaseScore,
  scoreBucket,
} from "./impulse.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");

describe("purchase score", () => {
  it("clamps both ends and lands on each bucket boundary", () => {
    assert.equal(purchaseScore(1, -3), 1);
    assert.equal(purchaseScore(2, -3), 1);
    assert.equal(purchaseScore(5, 3), 5);
    assert.equal(purchaseScore(4, 9), 5);
    assert.equal(purchaseScore(1.2, -3.4), 1);
    assert.equal(clampGrade(9), 3);
    assert.equal(clampGrade(-8), -3);
    assert.equal(clampGrade(1.6), 2);

    assert.equal(scoreBucket(purchaseScore(2, -1)), "strict");
    assert.equal(scoreBucket(1), "strict");
    assert.equal(scoreBucket(2), "soft");
    assert.equal(scoreBucket(3), "soft");
    assert.equal(scoreBucket(purchaseScore(2, 1)), "soft");
    assert.equal(scoreBucket(4), "free");
    assert.equal(scoreBucket(5), "free");
    assert.equal(scoreBucket(purchaseScore(2, 2)), "free");
  });
});

describe("necessity gate", () => {
  it("lets a necessary buy through and locks an unnecessary one", () => {
    const cable = keywordNecessity("USB-C charge cable");
    const phone = keywordNecessity("Example phone");
    assert.equal(cable.necessary, true);
    assert.equal(locksCheckout(cable), false);
    assert.equal(phone.necessary, false);
    assert.equal(locksCheckout(phone), true);
    assert.equal(keywordNecessity("iPhone 16 Pro").necessary, false);
  });

  it("counts a bag as necessary only when every item is", () => {
    const phoneCable = keywordNecessity("iPhone\nUSB-C cable");
    const cableFirst = keywordNecessity("USB-C cable\niPhone");
    const headphones = keywordNecessity("Headphones\nUSB-C charger");
    const chargerFirst = keywordNecessity("USB-C charger\nHeadphones");
    const parts = keywordNecessity("USB-C charge cable\n20W USB-C Power Adapter");
    assert.equal(phoneCable.necessary, false);
    assert.equal(locksCheckout(phoneCable), true);
    assert.equal(cableFirst.necessary, false);
    assert.equal(locksCheckout(cableFirst), true);
    assert.equal(headphones.necessary, false);
    assert.equal(locksCheckout(headphones), true);
    assert.equal(chargerFirst.necessary, false);
    assert.equal(parts.necessary, true);
    assert.equal(locksCheckout(parts), false);
    assert.equal(keywordNecessity("USB-C charge cable").necessary, true);
    assert.equal(keywordNecessity("USB-C cable").necessary, true);
    assert.equal(keywordNecessity("USB-C charger").necessary, true);
    assert.equal(keywordNecessity("iPhone").necessary, false);
    assert.equal(keywordNecessity("Headphones").necessary, false);
    assert.equal(keywordNecessity("Example phone").necessary, false);
    assert.equal(locksCheckout(keywordNecessity("Example phone")), true);
  });

  it("classifies real accessory names as necessary when Grok is absent", () => {
    for (const name of [
      "Apple Watch Magnetic Fast Charger to USB-C Cable",
      "MagSafe Charger",
      "20W USB-C Power Adapter",
      "iPhone 16 charger",
    ]) {
      const read = keywordNecessity(name);
      assert.equal(read.necessary, true, name);
      assert.equal(locksCheckout(read), false, name);
    }
  });

  it("lets Grok veto a keyword-necessary bag and keeps the keyword result when Grok fails", async () => {
    let calls = 0;
    const veto = await classifyNecessity("USB-C charge cable\nMagSafe Charger", {
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          choices: [{ message: { content: '{"necessary": false, "reason": "Stocking up."}' } }],
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(veto.source, "grok");
    assert.equal(veto.necessary, false);
    assert.equal(locksCheckout(veto), true);

    const singleVeto = await classifyNecessity("USB-C charge cable", {
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          choices: [{ message: { content: '{"necessary": false, "reason": "Want."}' } }],
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(singleVeto.source, "grok");
    assert.equal(singleVeto.necessary, false);

    const broken = await classifyNecessity("USB-C charge cable", {
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ choices: [{ message: { content: "nope" } }] });
      },
    });
    assert.equal(calls, 3);
    assert.equal(broken.source, "keywords");
    assert.equal(broken.necessary, true);

    const failed = await classifyNecessity("USB-C charge cable", {
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("timeout");
      },
    });
    assert.equal(calls, 4);
    assert.equal(failed.source, "keywords");
    assert.equal(failed.necessary, true);
    assert.equal(locksCheckout(failed), false);

    let network = false;
    const offline = await classifyNecessity("USB-C charge cable", {
      fetchImpl: async () => {
        network = true;
        throw new Error("network");
      },
    });
    assert.equal(network, false);
    assert.equal(offline.source, "keywords");
    assert.equal(offline.necessary, true);
  });

  it("does not let a Grok true loosen a bag that fails the keyword check", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: '{"necessary": true, "reason": "Yes."}' } }],
      });
    };
    const mixed = await classifyNecessity("iPhone\nUSB-C cable", { apiKey: "test-key", fetchImpl });
    const phone = await classifyNecessity("iPhone", { apiKey: "test-key", fetchImpl });
    const phoneOnly = await classifyNecessity("Example phone", { apiKey: "test-key", fetchImpl });
    assert.equal(calls, 0);
    assert.equal(mixed.necessary, false);
    assert.equal(mixed.source, "keywords");
    assert.equal(locksCheckout(mixed), true);
    assert.equal(phone.necessary, false);
    assert.equal(phone.source, "keywords");
    assert.equal(phoneOnly.necessary, false);
    assert.equal(phoneOnly.source, "keywords");

    const cable = await classifyNecessity("USB-C charge cable", {});
    assert.equal(cable.necessary, true);
    assert.equal(cable.source, "keywords");
  });
});

describe("justification grade", () => {
  it("parses an integer and clamps it to -3..3", () => {
    assert.deepEqual(parseGradeJson('{"grade": 2, "reason": "ok"}'), { grade: 2, reason: "ok" });
    assert.equal(parseGradeJson('{"grade": 9}')?.grade, 3);
    assert.equal(parseGradeJson('{"grade": -9}')?.grade, -3);
    assert.equal(parseGradeJson('Here:\n```json\n{"grade": "-2"}\n```')?.grade, -2);
    assert.equal(parseGradeJson("nope"), null);
    assert.equal(keywordGrade("the new color looks nice").grade, -2);
    assert.equal(keywordGrade("bored, treat myself").grade, -3);
    assert.equal(keywordGrade("I need it for work").grade, 1);
    assert.equal(keywordGrade("my battery dies by 3pm").grade, 2);
    assert.equal(
      keywordGrade("cracked screen, battery dies by 3pm, I need it for work tomorrow").grade,
      3,
    );
    assert.equal(keywordGrade("").grade, 0);
  });

  it("keeps the keyword grade when Grok is unset or unreadable", async () => {
    const offline = await gradeJustification("the new color looks nice", {});
    assert.equal(offline.source, "keywords");
    assert.equal(offline.grade, -2);

    const grok = await gradeJustification("the new color looks nice", {
      apiKey: "test-key",
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: '{"grade": 4, "reason": "High."}' } }],
        }),
    });
    assert.equal(grok.source, "grok");
    assert.equal(grok.grade, 3);

    const fallback = await gradeJustification("the new color looks nice", {
      apiKey: "test-key",
      fetchImpl: async () => {
        throw new Error("down");
      },
    });
    assert.equal(fallback.source, "keywords");
    assert.equal(fallback.grade, -2);
  });
});

describe("vault helpers", () => {
  it("keeps an enforced vault closed and liftCart opens it", () => {
    const held = cart();
    sleepCart(held, NOW, 24 * 60 * 60 * 1000, 60_000, "enforced");
    assert.equal(isEnforcedVault(held, NOW), true);
    assert.equal(unlockCart(held, NOW).isUnlocked, false);
    assert.equal(held.status, "vault");
    assert.equal(liftCart(held).status, "unlocked");
    assert.equal(held.vaultUntil, null);
    assert.equal(held.vaultMode, null);
  });
});

describe("score routing", () => {
  it("vaults a score of 1, offers sleep at 2–3, and unlocks at 4 or more", () => {
    const strict = cart();
    strict.decision = decide(withCartFacts({}, strict.totalCents));
    const held = applyPurchaseScore(strict, { grade: -2, source: "keywords", reason: "Look." }, 2, NOW, 60_000);
    assert.equal(held.bucket, "strict");
    assert.equal(strict.purchaseScore, 1);
    assert.equal(strict.status, "vault");
    assert.equal(strict.vaultMode, "enforced");
    assert.equal(strict.isUnlocked, false);
    assert.match(held.reply, /This one can wait/);
    assert.doesNotMatch(held.reply, /24 hours|Vault|skip 24/i);
    assert.match(held.reply, /example trade-in bundle/);

    const soft = cart();
    soft.decision = decide(withCartFacts({}, soft.totalCents));
    const optional = applyPurchaseScore(soft, { grade: 1, source: "keywords", reason: "Need." }, 2, NOW, 60_000);
    assert.equal(optional.bucket, "soft");
    assert.equal(soft.purchaseScore, 3);
    assert.equal(soft.status, "locked");
    assert.equal(soft.vaultUntil, null);
    assert.match(optional.reply, /optional/);

    const free = cart();
    const opened = applyPurchaseScore(free, { grade: 3, source: "grok", reason: "Broken." }, 2, NOW, 60_000);
    assert.equal(opened.bucket, "free");
    assert.equal(free.purchaseScore, 5);
    assert.equal(free.status, "unlocked");
    assert.equal(free.isUnlocked, true);
    assert.equal(free.vaultUntil, null);
    assert.match(opened.reply, /will not click it/);
    assert.match(opened.reply, /OK to buy/);
  });

  it("does not vault an under-floor bag when the justification is strict", () => {
    const grade = { grade: -2, source: "keywords" as const, reason: "Look." };
    const cheap = pricedCart(["Apple AirTag"], 3_200);
    cheap.decision = decide(withCartFacts({}, cheap.totalCents));
    const skipped = applyPurchaseScore(cheap, grade, 2, NOW, 60_000);
    assert.equal(skipped.bucket, "strict");
    assert.equal(cheap.purchaseScore, 1);
    assert.equal(cheap.scoreBucket, "strict");
    assert.equal(cheap.status, "locked");
    assert.equal(cheap.isUnlocked, false);
    assert.equal(cheap.vaultUntil, null);
    assert.equal(cheap.vaultMode, null);

    const pricey = pricedCart(["iPad Pro 11"], 99_900);
    pricey.decision = decide(withCartFacts({}, pricey.totalCents));
    const held = applyPurchaseScore(pricey, grade, 2, NOW, 60_000);
    assert.equal(held.bucket, "strict");
    assert.equal(pricey.purchaseScore, 1);
    assert.equal(pricey.scoreBucket, "strict");
    assert.equal(pricey.status, "vault");
    assert.equal(pricey.vaultMode, "enforced");
    assert.equal(pricey.isUnlocked, false);
    assert.notEqual(pricey.vaultUntil, null);
  });

  it("says a free score can be unlocked, and that Apple's button works only after Unlock", () => {
    const free = cart();
    free.decision = decide(withCartFacts({}, free.totalCents));
    applyPurchaseScore(free, { grade: 2, source: "keywords", reason: "A need." }, 2, NOW, 60_000);
    holdForUnlock(free);
    syncFreeBandCopy(free);
    assert.equal(free.purchaseScore, 4);
    assert.equal(free.isUnlocked, false);
    assert.equal(free.status, "locked");
    const before = free.explanation ?? "";
    assert.match(before, /Score 4 means this can be unlocked\. Press Unlock to get Apple's button back\./);
    assert.match(before, /This stays Paused\./);
    assert.equal(before.includes("Apple's button works again"), false);
    assert.equal(before.includes("unlocks the bag"), false);
    unlockCart(free, NOW);
    syncFreeBandCopy(free);
    assert.equal(free.isUnlocked, true);
    const after = free.explanation ?? "";
    assert.match(after, /OK to buy\. Apple's button works again\./);
    assert.equal(after.includes("Press Unlock"), false);
    assert.equal(after.includes("Paused"), false);
  });
});

describe("impulse flow on the server", () => {
  it("does not lock a necessary cable and routes the three phone buckets", async () => {
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const cable = await post(base, "/api/carts", {
        userId: "user-cable",
        itemNames: ["USB-C charge cable"],
        totalCents: 1_900,
        parsed: true,
        demo: true,
      });
      const open = cable.body as CartSnap;
      assert.equal(cable.status, 201);
      assert.equal(open.necessity, "necessary");
      assert.equal(open.necessitySource, "keywords");
      assert.equal(open.status, "unlocked");
      assert.equal(open.isUnlocked, true);
      assert.equal(open.lastPing, null);
      const pay = await post(base, "/api/pay", { code: open.code });
      assert.equal(pay.status, 200);
      const refusedSleep = await post(base, `/api/carts/${open.code}/sleep`, {});
      assert.equal(refusedSleep.status, 409);
      const stillOpen = (await get(base, `/api/carts/${open.code}`)) as CartSnap;
      assert.equal(stillOpen.status, "unlocked");
      assert.equal(stillOpen.isUnlocked, true);

      const phone = await post(base, "/api/carts", {
        userId: "user-impulsive",
        itemNames: ["Example phone"],
        totalCents: 120_000,
        parsed: true,
        demo: true,
      });
      const locked = phone.body as CartSnap;
      assert.equal(locked.necessity, "unnecessary");
      assert.equal(locked.impulse?.score1to8, 4.5);
      assert.equal(locked.impulse?.band, "soft");
      assert.equal(locked.impulse?.why, null);
      assert.equal(locked.hoursOfWork, null);
      assert.equal(locked.userImpulseScore, 2);
      assert.equal(locked.status, "locked");
      assert.equal(personaFor("user-someone-else").impulseScore, IMPULSIVE.impulseScore);

      const deliberate = await post(base, "/api/carts", {
        userId: "user-deliberate",
        itemNames: ["Example phone"],
        totalCents: 80_000,
        parsed: true,
        demo: true,
      });
      const fresh = deliberate.body as CartSnap;
      assert.equal(fresh.impulse?.score1to8, 4.5);
      assert.equal(fresh.userImpulseScore, 2);
      assert.notEqual(fresh.userImpulseScore, DELIBERATE.impulseScore);

      const conversationId = `desk:cart-${locked.code}`;
      await post(base, "/api/dev/messages", {
        conversationId,
        text: "the new color looks nice",
      });
      const strict = (await get(base, `/api/carts/${locked.code}`)) as CartSnap;
      assert.equal(strict.purchaseScore, 1);
      assert.equal(strict.scoreBucket, "strict");
      assert.equal(strict.gradeSource, "keywords");
      assert.equal(strict.status, "locked");
      assert.equal(strict.isUnlocked, false);
      assert.match(strict.explanation ?? "", /Impulsiveness 4\.5 of 8/);
      const held = await post(base, "/api/pay", { code: locked.code });
      assert.equal(held.status, 423);

      await post(base, "/api/dev/persona", { userId: "user-impulsive", persona: "deliberate" });
      const lifted = (await get(base, `/api/carts/${locked.code}`)) as CartSnap;
      assert.equal(lifted.userImpulseScore, 4);
      assert.equal(lifted.purchaseScore, 2);
      assert.equal(lifted.scoreBucket, "soft");
      assert.equal(lifted.status, "locked");

      const paused = await post(base, `/api/carts/${locked.code}/sleep`, {});
      const optional = paused.body as CartSnap & { vaultMode: string | null };
      assert.equal(optional.status, "vault");
      assert.equal(optional.vaultMode, "soft");
      const released = await post(base, `/api/carts/${locked.code}/unlock`, {});
      assert.equal(released.status, 200);
      assert.equal((released.body as CartSnap).isUnlocked, true);

      await post(base, "/api/dev/messages", {
        conversationId,
        text: "cracked screen, battery dies by 3pm, I need it for work tomorrow",
      });
      const freed = (await get(base, `/api/carts/${locked.code}`)) as CartSnap;
      assert.equal(freed.purchaseScore, 5);
      assert.equal(freed.scoreBucket, "free");
      assert.equal(freed.status, "locked");
      assert.equal(freed.isUnlocked, false);
      assert.match(freed.explanation ?? "", /Score 5 means this can be unlocked\. Press Unlock to get Apple's button back\./);
      assert.equal((freed.explanation ?? "").includes("Apple's button works again"), false);
      const openedBag = await post(base, `/api/carts/${locked.code}/unlock`, {});
      assert.equal(openedBag.status, 200);
      const bought = openedBag.body as CartSnap;
      assert.equal(bought.isUnlocked, true);
      assert.match(bought.explanation ?? "", /OK to buy\. Apple's button works again\./);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("checkout ping and a repeat post", () => {
  let mongod: MongoMemoryServer;
  let base = "";
  let memoryBase = "";
  let close: () => Promise<void> = async () => undefined;
  let closeMemory: () => Promise<void> = async () => undefined;
  let stop: () => void = () => undefined;
  let stopMemory: () => void = () => undefined;
  let store: ReturnType<typeof createMemoryStore>;
  let memoryStore: ReturnType<typeof createMemoryStore>;
  let regretClient: InMemoryBackboardClient;

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
    store = createMemoryStore();
    memoryStore = createMemoryStore();
    regretClient = new InMemoryBackboardClient();
    const unset = await listenApp(store, false);
    base = unset.base;
    close = unset.close;
    stop = unset.stop;
    const memory = await listenApp(memoryStore, true, regretClient);
    memoryBase = memory.base;
    closeMemory = memory.close;
    stopMemory = memory.stop;
  });

  after(async () => {
    stop();
    stopMemory();
    await close();
    await closeMemory();
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("unlocks a necessary bag without a ping and keeps a repeat from moving the lock", async () => {
    const cable = await post(base, "/api/carts", {
      userId: "user-cable-ping",
      itemNames: ["USB-C charge cable"],
      totalCents: 1_900,
      parsed: true,
      demo: true,
    });
    const open = cable.body as CartSnap;
    assert.equal(open.necessity, "necessary");
    assert.equal(open.isUnlocked, true);
    assert.equal(open.status, "unlocked");
    assert.equal(open.lastPing, null);
  });

  it("does not free a re-posted bag when kept purchases are on file and Backboard is unset", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const seen = await postedBag(base, store, userId, "desk:kept-unset");
    assert.equal(seen.first.impulse?.score1to8, 4.5);
    assert.equal(seen.first.impulse?.band, "soft");
    await PurchaseRecord.insertMany(keptPhones(userId, 5));
    const again = await post(base, "/api/carts", bagBody(userId));
    const replay = again.body as CartSnap;
    assert.equal(again.status, 200);
    assert.equal(replay.impulse?.score1to8, 4.5);
    assert.equal(replay.impulse?.band, "soft");
    assert.deepEqual(lockSnapshot(replay), lockSnapshot(seen.first));
    assert.equal(await pingCount(base, "desk:kept-unset"), 1);
  });

  it("leaves a re-posted unnecessary bag at 4.5 when regrets exist and Backboard is unset", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const seen = await postedBag(base, store, userId, "desk:regret-unset");
    await PurchaseRecord.insertMany(regrettedPhones(userId, 3));
    const again = await post(base, "/api/carts", bagBody(userId));
    const replay = again.body as CartSnap;
    assert.equal(again.status, 200);
    assert.equal(replay.impulse?.score1to8, 4.5);
    assert.equal(replay.impulse?.band, "soft");
    assert.equal(replay.impulse?.why ?? null, null);
    assert.equal(replay.status, "locked");
    assert.equal(replay.vaultUntil, null);
    assert.deepEqual(lockSnapshot(replay), lockSnapshot(seen.first));
    assert.equal(await pingCount(base, "desk:regret-unset"), 1);
  });

  it("scores a similar Backboard regret stricter than 4.5 and leaves a necessary bag alone", async () => {
    const assistant = await regretClient.createAssistant({
      name: "Simmer strict",
      systemPrompt: "Remember one shopper.",
    });
    const user = await User.create({
      email: "strict-score@example.com",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      backboardAssistantId: assistant.assistantId,
    });
    const seen = await postedBag(memoryBase, memoryStore, user.id, "desk:strict-score-7");
    assert.equal(seen.first.impulse?.score1to8, 4.5);
    await regretClient.addMemory(assistant.assistantId, {
      content: purchaseVoteLine("regretted", "Example phone", "phone", 80),
    });
    await PurchaseRecord.insertMany(regrettedPhones(user.id, 3));
    const again = await post(memoryBase, "/api/carts", bagBody(user.id));
    const replay = again.body as CartSnap;
    assert.equal(again.status, 200);
    assert.equal(replay.impulse?.score1to8, 5.2);
    assert.ok((replay.impulse?.score1to8 ?? 0) > 4.5);
    assert.equal(replay.impulse?.why, "You regretted a similar purchase before.");
    assert.equal(replay.impulse?.band, "strict");
    assert.equal(replay.status, "locked");
    assert.equal(replay.vaultUntil, null);
    assert.deepEqual(lockSnapshot(replay), lockSnapshot(seen.first));
    assert.equal(await pingCount(memoryBase, "desk:strict-score-7"), 1);

    const cable = await post(memoryBase, "/api/carts", {
      userId: user.id,
      itemNames: ["USB-C charge cable"],
      totalCents: 1_900,
      parsed: true,
      demo: true,
    });
    const open = cable.body as CartSnap;
    assert.equal(cable.status, 201);
    assert.equal(open.necessity, "necessary");
    assert.equal(open.impulse?.score1to8, 4.5);
    assert.equal(open.impulse?.why ?? null, null);
    assert.equal(open.isUnlocked, true);
  });
});

describe("mixed bags on both cart routes", () => {
  it("locks a new mixed bag and still opens a bag whose every item is necessary", async () => {
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const phoneCable = await post(base, "/api/carts", postedItems("user-phone-cable", ["iPhone", "USB-C cable"], 80_900));
      assert.equal(phoneCable.status, 201);
      const mixed = phoneCable.body as CartSnap;
      assert.equal(mixed.necessity, "unnecessary");
      assert.equal(mixed.necessitySource, "keywords");
      assert.equal(mixed.status, "locked");
      assert.equal(mixed.isUnlocked, false);
      assert.notEqual(mixed.lastPing, null);
      assert.equal(mixed.impulse?.score1to8, 4.5);
      assert.equal(mixed.impulse?.band, "soft");
      const held = await post(base, "/api/pay", { code: mixed.code });
      assert.equal(held.status, 423);

      const headphones = await post(
        base,
        "/api/carts",
        postedItems("user-headphones", ["Headphones", "USB-C charger"], 12_900),
      );
      const audio = headphones.body as CartSnap;
      assert.equal(headphones.status, 201);
      assert.equal(audio.necessity, "unnecessary");
      assert.equal(audio.status, "locked");
      assert.equal(audio.isUnlocked, false);
      assert.notEqual(audio.lastPing, null);

      const parts = await post(
        base,
        "/api/carts",
        postedItems("user-parts", ["USB-C charge cable", "20W USB-C Power Adapter"], 3_800),
      );
      const open = parts.body as CartSnap;
      assert.equal(parts.status, 201);
      assert.equal(open.necessity, "necessary");
      assert.equal(open.necessitySource, "keywords");
      assert.equal(open.status, "unlocked");
      assert.equal(open.isUnlocked, true);
      assert.equal(open.lastPing, null);
      const paid = await post(base, "/api/pay", { code: open.code });
      assert.equal(paid.status, 200);

      const cable = await post(base, "/api/carts", postedItems("user-one-cable", ["USB-C charge cable"], 1_900));
      const singleCable = cable.body as CartSnap;
      assert.equal(cable.status, 201);
      assert.equal(singleCable.necessity, "necessary");
      assert.equal(singleCable.isUnlocked, true);
      assert.equal(singleCable.lastPing, null);

      const phone = await post(base, "/api/carts", postedItems("user-one-phone", ["Example phone"], 120_000));
      const singlePhone = phone.body as CartSnap;
      assert.equal(phone.status, 201);
      assert.equal(singlePhone.necessity, "unnecessary");
      assert.equal(singlePhone.status, "locked");
      assert.equal(singlePhone.isUnlocked, false);
      assert.notEqual(singlePhone.lastPing, null);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("repairs a deduped cart per item when necessity was never stored", async () => {
    const store = createMemoryStore();
    const running = createApp({
      store,
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const phoneCable = await repostWithoutNecessity(store, base, postedItems("user-repair-phone", ["iPhone", "USB-C cable"], 80_900));
      assert.equal(phoneCable.httpStatus, 200);
      assert.equal(phoneCable.cart.necessity, "unnecessary");
      assert.equal(phoneCable.cart.necessitySource, "keywords");
      assert.equal(phoneCable.cart.status, "locked");
      assert.equal(phoneCable.cart.isUnlocked, false);
      assert.notEqual(phoneCable.cart.lastPing, null);

      const headphones = await repostWithoutNecessity(
        store,
        base,
        postedItems("user-repair-audio", ["Headphones", "USB-C charger"], 12_900),
      );
      assert.equal(headphones.httpStatus, 200);
      assert.equal(headphones.cart.necessity, "unnecessary");
      assert.equal(headphones.cart.status, "locked");
      assert.equal(headphones.cart.isUnlocked, false);
      assert.notEqual(headphones.cart.lastPing, null);

      const parts = await repostWithoutNecessity(
        store,
        base,
        postedItems("user-repair-parts", ["USB-C charge cable", "MagSafe Charger"], 4_800),
      );
      assert.equal(parts.httpStatus, 200);
      assert.equal(parts.cart.necessity, "necessary");
      assert.equal(parts.cart.necessitySource, "keywords");
      assert.equal(parts.cart.status, "unlocked");
      assert.equal(parts.cart.isUnlocked, true);
      assert.equal(parts.cart.lastPing, null);

      const cable = await repostWithoutNecessity(store, base, postedItems("user-repair-cable", ["USB-C charge cable"], 1_900));
      assert.equal(cable.httpStatus, 200);
      assert.equal(cable.cart.necessity, "necessary");
      assert.equal(cable.cart.status, "unlocked");
      assert.equal(cable.cart.isUnlocked, true);
      assert.equal(cable.cart.lastPing, null);

      const phone = await repostWithoutNecessity(store, base, postedItems("user-repair-phone-only", ["iPhone 16 Pro"], 119_900));
      assert.equal(phone.httpStatus, 200);
      assert.equal(phone.cart.necessity, "unnecessary");
      assert.equal(phone.cart.status, "locked");
      assert.equal(phone.cart.isUnlocked, false);
      assert.notEqual(phone.cart.lastPing, null);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("pause floor", () => {
  it("unlocks a bag under $40 and still pauses a bag at or above it", async () => {
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const airtag = await post(base, "/api/carts", postedItems("user-airtag", ["Apple AirTag"], 3_200));
      const cheap = airtag.body as CartSnap;
      assert.equal(airtag.status, 201);
      assert.equal(cheap.necessity, "unnecessary");
      assert.equal(cheap.necessitySource, "keywords");
      assert.equal(cheap.status, "unlocked");
      assert.equal(cheap.isUnlocked, true);
      assert.equal(cheap.lastPing, null);
      assert.equal(cheap.vaultUntil ?? null, null);
      assert.equal(cheap.impulse?.score1to8, 4.5);
      assert.equal(cheap.impulse?.band, "soft");
      assert.equal(cheap.impulse?.why ?? null, null);
      assert.equal(cheap.userImpulseScore, 2);
      const paid = await post(base, "/api/pay", { code: cheap.code });
      assert.equal(paid.status, 200);

      const cloth = await post(
        base,
        "/api/carts",
        postedItems("user-cloth", ["Apple AirTag", "Polishing cloth"], 3_500),
      );
      const several = cloth.body as CartSnap;
      assert.equal(cloth.status, 201);
      assert.equal(several.necessity, "unnecessary");
      assert.equal(several.status, "unlocked");
      assert.equal(several.isUnlocked, true);
      assert.equal(several.lastPing, null);
      assert.equal(several.impulse?.score1to8, 4.5);

      const boundary = await post(base, "/api/carts", postedItems("user-boundary", ["Apple AirTag"], 4_000));
      const exact = boundary.body as CartSnap;
      assert.equal(boundary.status, 201);
      assert.equal(exact.necessity, "unnecessary");
      assert.equal(exact.status, "locked");
      assert.equal(exact.isUnlocked, false);
      assert.notEqual(exact.lastPing, null);
      assert.equal(exact.impulse?.score1to8, 4.5);
      const held = await post(base, "/api/pay", { code: exact.code });
      assert.equal(held.status, 423);

      const ipad = await post(base, "/api/carts", postedItems("user-ipad", ["iPad Pro 11"], 99_900));
      const tablet = ipad.body as CartSnap;
      assert.equal(ipad.status, 201);
      assert.equal(tablet.necessity, "unnecessary");
      assert.equal(tablet.necessitySource, "keywords");
      assert.equal(tablet.status, "locked");
      assert.equal(tablet.isUnlocked, false);
      assert.notEqual(tablet.lastPing, null);
      assert.equal(tablet.impulse?.score1to8, 4.5);
      const paused = await post(base, "/api/pay", { code: tablet.code });
      assert.equal(paused.status, 423);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("unlocks a reused under-floor bag without a ping", async () => {
    const store = createMemoryStore();
    const running = createApp({
      store,
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const again = await repostWithoutNecessity(store, base, postedItems("user-airtag-reuse", ["Apple AirTag", "Polishing cloth"], 3_900));
      assert.equal(again.httpStatus, 200);
      assert.equal(again.cart.necessity, "unnecessary");
      assert.equal(again.cart.necessitySource, "keywords");
      assert.equal(again.cart.status, "unlocked");
      assert.equal(again.cart.isUnlocked, true);
      assert.equal(again.cart.lastPing, null);
      assert.equal(again.cart.impulse?.score1to8, 4.5);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("keyword necessity on the request path", () => {
  it("answers with keywords before a slow Grok call and repairs a deduped cart", async () => {
    const store = createMemoryStore();
    const waiters: Array<(response: Response) => void> = [];
    const running = createApp({
      store,
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiApiKey: "test-key",
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 60_000,
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          waiters.push(resolve);
        }),
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const bag = {
      userId: "user-fast",
      itemNames: ["USB-C charge cable"],
      totalCents: 1_900,
      parsed: true,
      demo: true,
    };
    try {
      const started = Date.now();
      const created = await post(base, "/api/carts", bag);
      assert.ok(Date.now() - started < 1_000);
      const open = created.body as CartSnap;
      assert.equal(created.status, 201);
      assert.equal(open.necessity, "necessary");
      assert.equal(open.necessitySource, "keywords");
      assert.equal(open.isUnlocked, true);

      const stored = store.getCart(open.code);
      assert.ok(stored);
      stored.necessity = null;
      stored.necessitySource = null;
      stored.necessityReason = null;
      store.saveCart(stored);
      const again = await post(base, "/api/carts", bag);
      const replay = again.body as CartSnap;
      assert.equal(again.status, 200);
      assert.equal(replay.code, open.code);
      assert.equal(replay.necessity, "necessary");
      assert.equal(replay.necessitySource, "keywords");

      for (const resolve of waiters) {
        resolve(
          Response.json({
            choices: [{ message: { content: '{"necessary": false, "reason": "Want."}' } }],
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const revised = (await get(base, `/api/carts/${open.code}`)) as CartSnap;
      assert.equal(revised.necessitySource, "grok");
      assert.equal(revised.necessity, "unnecessary");
      assert.equal(revised.status, "unlocked");
      assert.equal(revised.isUnlocked, true);
      assert.equal(revised.lastPing, null);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not unlock a mixed bag when Grok says necessary", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const running = createApp({
      store,
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiApiKey: "test-key",
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          choices: [{ message: { content: '{"necessary": true, "reason": "Cable."}' } }],
        });
      },
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await post(base, "/api/carts", postedItems("user-grok-mixed", ["iPhone", "USB-C cable"], 80_900));
      assert.equal(created.status, 201);
      const locked = created.body as CartSnap;
      assert.equal(locked.necessity, "unnecessary");
      assert.equal(locked.necessitySource, "keywords");
      assert.equal(locked.status, "locked");
      assert.equal(locked.isUnlocked, false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const revised = (await get(base, `/api/carts/${locked.code}`)) as CartSnap;
      assert.equal(calls, 0);
      assert.equal(revised.necessity, "unnecessary");
      assert.equal(revised.necessitySource, "keywords");
      assert.equal(revised.status, "locked");
      assert.equal(revised.isUnlocked, false);
      const stored = store.getCart(locked.code);
      assert.ok(stored);
      assert.equal(stored.isUnlocked, false);
      assert.equal(stored.status, "locked");
      const pay = await post(base, "/api/pay", { code: locked.code });
      assert.equal(pay.status, 423);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("lets Grok lock a keyword-necessary bag at the pause floor", async () => {
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: true,
      agentHandle: null,
      photon: null,
      xaiApiKey: "test-key",
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: '{"necessary": false, "reason": "Want."}' } }],
        }),
      polish: async (template) => template,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await post(base, "/api/carts", postedItems("user-floor-grok", ["USB-C charge cable"], 4_000));
      assert.equal(created.status, 201);
      const pending = created.body as CartSnap;
      assert.equal(pending.necessity, "necessary");
      assert.equal(pending.necessitySource, "keywords");
      assert.equal(pending.status, "locked");
      assert.equal(pending.isUnlocked, false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const revised = (await get(base, `/api/carts/${pending.code}`)) as CartSnap;
      assert.equal(revised.necessitySource, "grok");
      assert.equal(revised.necessity, "unnecessary");
      assert.equal(revised.status, "locked");
      assert.equal(revised.isUnlocked, false);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("refineNecessity holds a keyword-necessary bag for the Grok veto", () => {
  it("keeps a necessary bag pending until Grok confirms, then unlocks", async () => {
    const held = deferResponse();
    const running = await listenGrokApp(held.fetchImpl);
    try {
      const created = await post(running.base, "/api/carts", cableAtFloor("user-grok-confirm"));
      assert.equal(created.status, 201);
      const pending = created.body as CartSnap;
      assert.equal(pending.necessity, "necessary");
      assert.equal(pending.necessitySource, "keywords");
      assert.equal(pending.status, "locked");
      assert.equal(pending.isUnlocked, false);
      const stillPending = (await get(running.base, `/api/carts/${pending.code}`)) as CartSnap;
      assert.equal(stillPending.isUnlocked, false);
      assert.equal(stillPending.status, "locked");

      held.resolve(necessityJson(true, "A cable keeps the phone charging."));
      const opened = await waitForCart(running.base, pending.code, (cart) => cart.necessitySource === "grok" && cart.isUnlocked);
      assert.equal(opened.necessity, "necessary");
      assert.equal(opened.necessitySource, "grok");
      assert.equal(opened.status, "unlocked");
      assert.equal(opened.isUnlocked, true);
      const pay = await post(running.base, "/api/pay", { code: pending.code });
      assert.equal(pay.status, 200);
    } finally {
      await running.close();
    }
  });

  it("keeps the bag locked when Grok vetoes", async () => {
    const held = deferResponse();
    const running = await listenGrokApp(held.fetchImpl);
    try {
      const created = await post(running.base, "/api/carts", cableAtFloor("user-grok-veto"));
      const pending = created.body as CartSnap;
      assert.equal(pending.isUnlocked, false);
      held.resolve(necessityJson(false, "Want."));
      const revised = await waitForCart(running.base, pending.code, (cart) => cart.necessitySource === "grok");
      assert.equal(revised.necessity, "unnecessary");
      assert.equal(revised.necessitySource, "grok");
      assert.equal(revised.status, "locked");
      assert.equal(revised.isUnlocked, false);
      const pay = await post(running.base, "/api/pay", { code: pending.code });
      assert.equal(pay.status, 423);
      assert.equal((pay.body as { ok: boolean; reason: string }).ok, false);
      assert.equal((pay.body as { reason: string }).reason, "locked");
    } finally {
      await running.close();
    }
  });

  it("unlocks from the keyword result when Grok errors", async () => {
    const running = await listenGrokApp(async () => {
      throw new Error("timeout");
    });
    try {
      const created = await post(running.base, "/api/carts", cableAtFloor("user-grok-error"));
      const pending = created.body as CartSnap;
      assert.equal(created.status, 201);
      assert.equal(pending.necessity, "necessary");
      assert.equal(pending.necessitySource, "keywords");
      assert.equal(pending.isUnlocked, false);
      const opened = await waitForCart(running.base, pending.code, (cart) => cart.isUnlocked);
      assert.equal(opened.necessity, "necessary");
      assert.equal(opened.necessitySource, "keywords");
      assert.equal(opened.status, "unlocked");
      assert.equal(opened.isUnlocked, true);
      const pay = await post(running.base, "/api/pay", { code: pending.code });
      assert.equal(pay.status, 200);
    } finally {
      await running.close();
    }
  });

  it("does not return a silent 200 when pay is clicked while the veto is pending", async () => {
    const held = deferResponse();
    const running = await listenGrokApp(held.fetchImpl);
    try {
      const created = await post(running.base, "/api/carts", cableAtFloor("user-grok-pay"));
      const pending = created.body as CartSnap;
      assert.equal(pending.status, "locked");
      assert.equal(pending.isUnlocked, false);
      const pay = await post(running.base, "/api/pay", { code: pending.code });
      assert.notEqual(pay.status, 200);
      assert.equal(pay.status, 423);
      const gate = pay.body as { ok: boolean; httpStatus: number; isUnlocked: boolean; reason: string };
      assert.equal(gate.ok, false);
      assert.equal(gate.httpStatus, 423);
      assert.equal(gate.isUnlocked, false);
      assert.equal(gate.reason, "locked");
      const unchanged = (await get(running.base, `/api/carts/${pending.code}`)) as CartSnap;
      assert.equal(unchanged.isUnlocked, false);
      assert.equal(unchanged.status, "locked");
      assert.equal(unchanged.necessity, "necessary");
      assert.equal(unchanged.necessitySource, "keywords");
    } finally {
      held.resolve(necessityJson(true, "Cable."));
      await running.close();
    }
  });

  it("does not hold a carrier cart at the pause floor when the item is keyword-necessary", async () => {
    let grokCalls = 0;
    const running = await listenGrokApp(() => {
      grokCalls += 1;
      return new Promise<Response>(() => undefined);
    });
    try {
      const passed = await post(running.base, "/api/carts", {
        ...cableAtFloor("user-carrier-pass"),
        totalCents: CARRIER_PASS.newMonthlyCents,
        carrier: CARRIER_PASS,
      });
      assert.equal(passed.status, 201);
      const open = passed.body as CartSnap & { carrierLine?: string | null };
      assert.equal(open.necessity, "necessary");
      assert.equal(open.status, "unlocked");
      assert.equal(open.isUnlocked, true);
      assert.equal(open.carrierLine, carrierSentence(CARRIER_PASS));
      const pay = await post(running.base, "/api/pay", { code: open.code });
      assert.equal(pay.status, 200);
      assert.equal((pay.body as { ok: boolean; isUnlocked: boolean }).ok, true);
      assert.equal((pay.body as { isUnlocked: boolean }).isUnlocked, true);

      const waiting = await post(running.base, "/api/carts", {
        ...cableAtFloor("user-carrier-wait"),
        totalCents: CARRIER_WAIT.newMonthlyCents,
        carrier: CARRIER_WAIT,
      });
      assert.equal(waiting.status, 201);
      const heldCart = waiting.body as CartSnap & { carrierLine?: string | null };
      assert.equal(heldCart.necessity, "unnecessary");
      assert.equal(heldCart.status, "locked");
      assert.equal(heldCart.isUnlocked, false);
      assert.equal(heldCart.carrierLine, carrierSentence(CARRIER_WAIT));
      const blocked = await post(running.base, "/api/pay", { code: heldCart.code });
      assert.equal(blocked.status, 423);
      assert.equal((blocked.body as { ok: boolean; reason: string }).ok, false);
      assert.equal((blocked.body as { reason: string }).reason, "locked");
      assert.equal(grokCalls, 0);
    } finally {
      await running.close();
    }
  });
});

function cableAtFloor(userId: string) {
  return postedItems(userId, ["USB-C charge cable"], 4_500);
}

function necessityJson(necessary: boolean, reason: string): Response {
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ necessary, reason }) } }],
  });
}

function deferResponse(): { fetchImpl: typeof fetch; resolve: (response: Response) => void } {
  let resolveResponse: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    fetchImpl: () => pending,
    resolve: resolveResponse,
  };
}

async function listenGrokApp(fetchImpl: typeof fetch): Promise<{ base: string; close: () => Promise<void> }> {
  const running = createApp({
    store: createMemoryStore(),
    origin: "http://127.0.0.1",
    lockMs: 600_000,
    demoReminderMs: 60_000,
    demoDefault: true,
    agentHandle: null,
    photon: null,
    xaiApiKey: "test-key",
    xaiModel: "grok-4.20-0309-non-reasoning",
    xaiTimeoutMs: 8_000,
    fetchImpl,
    polish: async (template) => template,
  });
  const server = createServer(running.app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        running.scheduler.stop();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function waitForCart(base: string, code: string, ready: (cart: CartSnap) => boolean): Promise<CartSnap> {
  const deadline = Date.now() + 2_000;
  let latest: CartSnap | null = null;
  while (Date.now() < deadline) {
    latest = (await get(base, `/api/carts/${code}`)) as CartSnap;
    if (ready(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`cart ${code} stayed ${latest?.status ?? "missing"} / ${latest?.necessitySource ?? "none"}`);
}

function cart() {
  return pricedCart(["Example phone"], 120_000);
}

function pricedCart(names: string[], totalCents: number) {
  return startLockedCart({
    items: itemsForBag(names, totalCents, false),
    totalCents,
    parsedFromPage: false,
    pageHost: "127.0.0.1",
    fingerprint: `user|${totalCents}|${names.join("|").toLowerCase()}`,
    now: NOW,
    demo: true,
    lockMs: 600_000,
    userId: "user-impulsive",
    code: "AB23CD",
  });
}

type CartSnap = {
  code: string;
  status: string;
  isUnlocked: boolean;
  necessity: string | null;
  necessitySource: string | null;
  userImpulseScore: number | null;
  impulse?: { score1to8: number; band: string; why: string | null } | null;
  hoursOfWork?: { hours: number; hourlyRate: number } | null;
  purchaseScore: number | null;
  scoreBucket: string | null;
  gradeSource: string | null;
  lastPing: unknown;
  explanation: string | null;
  vaultUntil?: string | null;
  vaultMode?: string | null;
  reminderAt?: string | null;
  reminderFireAt?: string | null;
  reminderSentAt?: string | null;
  lockEndsAt?: string | null;
};

async function listenApp(
  appStore: ReturnType<typeof createMemoryStore>,
  backboardEnabled: boolean,
  backboardClient?: InMemoryBackboardClient,
): Promise<{ base: string; close: () => Promise<void>; stop: () => void }> {
  const running = createApp({
    store: appStore,
    origin: "http://127.0.0.1",
    lockMs: 600_000,
    demoReminderMs: 60_000,
    demoDefault: true,
    agentHandle: null,
    photon: null,
    xaiModel: "grok-4.20-0309-non-reasoning",
    xaiTimeoutMs: 8_000,
    polish: async (template) => template,
    backboardEnabled,
    ...(backboardClient ? { backboardClient } : {}),
  });
  const server = createServer(running.app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    stop: () => running.scheduler.stop(),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function bagBody(userId: string): { userId: string; itemNames: string[]; totalCents: number; parsed: boolean; demo: boolean } {
  return postedItems(userId, ["Example phone"], 120_000);
}

function postedItems(
  userId: string,
  itemNames: string[],
  totalCents: number,
): { userId: string; itemNames: string[]; totalCents: number; parsed: boolean; demo: boolean } {
  return { userId, itemNames, totalCents, parsed: true, demo: true };
}

async function repostWithoutNecessity(
  store: ReturnType<typeof createMemoryStore>,
  base: string,
  bag: { userId: string; itemNames: string[]; totalCents: number; parsed: boolean; demo: boolean },
): Promise<{ httpStatus: number; cart: CartSnap }> {
  const created = await post(base, "/api/carts", bag);
  const first = created.body as CartSnap;
  assert.equal(created.status, 201);
  const stored = store.getCart(first.code);
  assert.ok(stored);
  stored.necessity = null;
  stored.necessitySource = null;
  stored.necessityReason = null;
  stored.isUnlocked = true;
  stored.status = "unlocked";
  stored.lastPing = null;
  store.saveCart(stored);
  const again = await post(base, "/api/carts", bag);
  return { httpStatus: again.status, cart: again.body as CartSnap };
}

function keptPhones(userId: string, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({
    userId,
    item: "Old phone",
    category: "phone",
    price: 80,
    feedback: "kept",
    isExample: false,
    source: "checkout",
  }));
}

function regrettedPhones(userId: string, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({
    userId,
    item: "Old phone",
    category: "phone",
    price: 80,
    feedback: "regretted",
    isExample: false,
    source: "checkout",
  }));
}

async function postedBag(
  base: string,
  store: ReturnType<typeof createMemoryStore>,
  userId: string,
  conversationId: string,
): Promise<{ first: CartSnap }> {
  store.savePhoneLink({ userId, conversationId, linkedAt: "2026-10-18T00:00:00.000Z" });
  const created = await post(base, "/api/carts", bagBody(userId));
  const first = created.body as CartSnap;
  assert.equal(created.status, 201);
  assert.equal(first.status, "locked");
  assert.equal(first.isUnlocked, false);
  assert.equal(first.vaultUntil ?? null, null);
  return { first };
}

function lockSnapshot(cart: CartSnap): {
  status: string;
  isUnlocked: boolean;
  vaultUntil: string | null;
  vaultMode: string | null;
  reminderAt: string | null;
  reminderFireAt: string | null;
  reminderSentAt: string | null;
  lockEndsAt: string | null;
  userImpulseScore: number | null;
  lastPing: unknown;
} {
  return {
    status: cart.status,
    isUnlocked: cart.isUnlocked,
    vaultUntil: cart.vaultUntil ?? null,
    vaultMode: cart.vaultMode ?? null,
    reminderAt: cart.reminderAt ?? null,
    reminderFireAt: cart.reminderFireAt ?? null,
    reminderSentAt: cart.reminderSentAt ?? null,
    lockEndsAt: cart.lockEndsAt ?? null,
    userImpulseScore: cart.userImpulseScore,
    lastPing: cart.lastPing,
  };
}

async function pingCount(base: string, conversationId: string): Promise<number> {
  const thread = (await get(base, `/api/dev/messages?conversationId=${conversationId}`)) as {
    turns: { role: string; text: string }[];
  };
  return thread.turns.filter((turn) => turn.role === "agent" && turn.text.includes("paused your")).length;
}

async function get(base: string, path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.ok, true);
  return response.json() as Promise<unknown>;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as unknown;
  return { status: response.status, body: parsed };
}
