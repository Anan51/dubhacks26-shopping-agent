import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { createApp } from "../app.js";
import { connectMongo } from "../auth/db.js";
import { User } from "../auth/user.js";
import { itemsForBag, startLockedCart, withCartFacts } from "../carts.js";
import { decide } from "../heuristic.js";
import type { BackboardClient, MemorySearchHit } from "../memory/backboard.js";
import { createMemoryStore } from "../store.js";
import type { Cart } from "../types.js";
import { applyImpulseReading, readingForCart, type CartReading } from "./cartReading.js";
import { EMPTY_IMPULSE_SIGNALS, scoreFromSignals } from "./backboardScore.js";
import {
  CARRIER_PASS,
  CARRIER_WAIT,
  applyCarrierLine,
  breakEvenMonths,
  carrierCardLine,
  carrierSentence,
  carrierVerdict,
  monthlySavingCents,
  parseCarrierFacts,
  upfrontCents,
  type CarrierFacts,
} from "./carrierSwitch.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const REGRET_WHY = "You regretted a similar purchase before.";

describe("carrier switch reasoning", () => {
  it("computes break-even months from the balance, the fee, and the monthly saving", () => {
    assert.equal(monthlySavingCents(CARRIER_WAIT), 600);
    assert.equal(upfrontCents(CARRIER_WAIT), 48_000);
    assert.equal(breakEvenMonths(CARRIER_WAIT), 80);
    assert.equal(carrierVerdict(CARRIER_WAIT), "wait");
    assert.equal(
      carrierSentence(CARRIER_WAIT),
      "You'd pay $360 left on the phone plus a $120 fee to save $6 a month. That takes 80 months to break even. 12 months are left on the phone.",
    );

    const partial: CarrierFacts = {
      currentMonthlyCents: 5_000,
      newMonthlyCents: 2_000,
      balanceCents: 10_000,
      monthsLeft: 4,
      feeCents: 1,
    };
    assert.equal(breakEvenMonths(partial), 4);
    assert.equal(carrierVerdict(partial), "wait");

    const oneMonth: CarrierFacts = {
      currentMonthlyCents: 2_000,
      newMonthlyCents: 1_000,
      balanceCents: 1_000,
      monthsLeft: 1,
      feeCents: 0,
    };
    assert.equal(breakEvenMonths(oneMonth), 1);
    assert.equal(
      carrierSentence(oneMonth),
      "You'd pay $10 left on the phone plus a $0 fee to save $10 a month. That takes 1 month to break even. 1 month is left on the phone.",
    );
  });

  it("treats a zero balance and a zero fee on a cheaper plan as no reason to wait", () => {
    assert.equal(upfrontCents(CARRIER_PASS), 0);
    assert.equal(monthlySavingCents(CARRIER_PASS), 2_500);
    assert.equal(breakEvenMonths(CARRIER_PASS), 0);
    assert.equal(carrierVerdict(CARRIER_PASS), "pass");
    assert.equal(
      carrierSentence(CARRIER_PASS),
      "There's no reason to wait. Nothing is left on the phone, there's no fee, and the new plan is $25 a month cheaper.",
    );

    const samePrice: CarrierFacts = {
      currentMonthlyCents: 8_000,
      newMonthlyCents: 8_000,
      balanceCents: 0,
      monthsLeft: 0,
      feeCents: 0,
    };
    assert.equal(breakEvenMonths(samePrice), null);
    assert.equal(carrierVerdict(samePrice), "wait");
    assert.match(carrierSentence(samePrice), /not cheaper/);
    assert.equal(carrierSentence(samePrice).includes("break even"), false);
  });

  it("appends the existing regret line and does not invent one", () => {
    assert.equal(carrierCardLine(CARRIER_WAIT, null), carrierSentence(CARRIER_WAIT));
    assert.equal(carrierCardLine(CARRIER_WAIT, "  "), carrierSentence(CARRIER_WAIT));
    assert.equal(
      carrierCardLine(CARRIER_WAIT, REGRET_WHY),
      `${carrierSentence(CARRIER_WAIT)} ${REGRET_WHY}`,
    );
    assert.equal(
      carrierCardLine(CARRIER_PASS, REGRET_WHY),
      `${carrierSentence(CARRIER_PASS)} ${REGRET_WHY}`,
    );

    const scored = scoreFromSignals(
      { item: "Switch to Carrier X", category: "other", price: 74, necessary: false },
      { ...EMPTY_IMPULSE_SIGNALS, categoryRegrets: 1 },
    );
    assert.equal(scored.why, REGRET_WHY);
    const cart = startLockedCart({
      items: itemsForBag(["Switch to Carrier X"], CARRIER_WAIT.newMonthlyCents, true),
      totalCents: CARRIER_WAIT.newMonthlyCents,
      parsedFromPage: true,
      pageHost: "127.0.0.1",
      fingerprint: "user-regret|7400|switch to carrier x",
      now: NOW,
      demo: false,
      lockMs: 600_000,
      userId: "user-regret",
      code: "WAIT01",
    });
    cart.impulse = { score1to8: scored.score, band: "strict", why: scored.why };
    cart.necessity = "unnecessary";
    applyCarrierLine(cart, CARRIER_WAIT);
    assert.equal(cart.carrierLine, carrierCardLine(CARRIER_WAIT, REGRET_WHY));
    assert.equal(cart.isUnlocked, false);
    assert.equal(cart.status, "locked");
  });

  it("keeps a vault on wait and lets a zero-cost cheaper plan through", () => {
    const waiting = startLockedCart({
      items: itemsForBag(["Switch to Carrier X"], CARRIER_WAIT.newMonthlyCents, true),
      totalCents: CARRIER_WAIT.newMonthlyCents,
      parsedFromPage: true,
      pageHost: "127.0.0.1",
      fingerprint: "vault-wait",
      now: NOW,
      demo: true,
      lockMs: 600_000,
      userId: "user-vault",
      code: "VAULT1",
    });
    waiting.necessity = "unnecessary";
    applyImpulseReading(waiting, strictReading(REGRET_WHY), NOW, 60_000, "create");
    assert.equal(waiting.status, "vault");
    applyCarrierLine(waiting, CARRIER_WAIT);
    assert.equal(waiting.status, "vault");
    assert.equal(waiting.isUnlocked, false);
    assert.match(waiting.carrierLine ?? "", /80 months to break even/);
    assert.match(waiting.carrierLine ?? "", /regretted a similar purchase/);

    const passing = startLockedCart({
      items: itemsForBag(["Switch to Carrier X"], CARRIER_PASS.newMonthlyCents, true),
      totalCents: CARRIER_PASS.newMonthlyCents,
      parsedFromPage: true,
      pageHost: "127.0.0.1",
      fingerprint: "vault-pass",
      now: NOW,
      demo: true,
      lockMs: 600_000,
      userId: "user-vault",
      code: "PASS01",
    });
    passing.necessity = "unnecessary";
    applyImpulseReading(passing, strictReading(REGRET_WHY), NOW, 60_000, "create");
    assert.equal(passing.status, "vault");
    applyCarrierLine(passing, CARRIER_PASS);
    assert.equal(passing.status, "unlocked");
    assert.equal(passing.isUnlocked, true);
    assert.equal(passing.vaultUntil, null);
    assert.equal(passing.necessity, "necessary");
    assert.equal(passing.carrierLine, carrierCardLine(CARRIER_PASS, REGRET_WHY));
  });

  it("leaves the lock alone on wait when a purchase score is already set", () => {
    const scored = startLockedCart({
      items: itemsForBag(["Switch to Carrier X"], CARRIER_WAIT.newMonthlyCents, true),
      totalCents: CARRIER_WAIT.newMonthlyCents,
      parsedFromPage: true,
      pageHost: "127.0.0.1",
      fingerprint: "score-wait",
      now: NOW,
      demo: false,
      lockMs: 600_000,
      userId: "user-score-wait",
      code: "SCORE3",
    });
    scored.purchaseScore = 5;
    scored.scoreBucket = "free";
    scored.status = "unlocked";
    scored.isUnlocked = true;
    scored.scoreReason = "Clear reason.";
    scored.necessity = "necessary";
    applyCarrierLine(scored, CARRIER_WAIT);
    assert.equal(scored.purchaseScore, 5);
    assert.equal(scored.status, "unlocked");
    assert.equal(scored.isUnlocked, true);
    assert.equal(scored.scoreReason, "Clear reason.");
    assert.equal(scored.necessity, "unnecessary");
    assert.equal(scored.carrierLine, carrierSentence(CARRIER_WAIT));
  });

  it("keeps one priced plan line after the carrier sentence, and an iPhone still scores over a cable", async () => {
    const planCents = 3_500;
    const carrier = startLockedCart({
      items: itemsForBag(["Switch to Carrier X"], planCents, true),
      totalCents: planCents,
      parsedFromPage: true,
      pageHost: "127.0.0.1",
      fingerprint: "score|3500|switch to carrier x",
      now: NOW,
      demo: false,
      lockMs: 600_000,
      userId: "user-score",
      code: "SCORE1",
    });
    carrier.necessity = "unnecessary";
    applyCarrierLine(carrier, {
      currentMonthlyCents: 8_000,
      newMonthlyCents: planCents,
      balanceCents: 36_000,
      monthsLeft: 12,
      feeCents: 12_000,
    });
    const priced = carrier.items.filter((item) => item.priceCents > 0);
    assert.equal(priced.length, 1);
    assert.equal(priced[0]?.name, "Switch to Carrier X");
    assert.equal(carrier.carrierLine?.includes("$360"), true);

    const apple = startLockedCart({
      items: itemsForBag(["iPhone", "USB-C cable"], 80_900, true),
      totalCents: 80_900,
      parsedFromPage: true,
      pageHost: "www.apple.com",
      fingerprint: "score|80900|iphone|usb-c cable",
      now: NOW,
      demo: false,
      lockMs: 600_000,
      userId: "user-score",
      code: "SCORE2",
    });
    apple.necessity = "unnecessary";
    assert.equal(apple.carrierLine ?? null, null);
    assert.equal(apple.items.filter((item) => item.priceCents > 0).length, 1);

    const queries: string[] = [];
    const carrierQuery = await scoreQuery(carrier, queries);
    const appleQuery = await scoreQuery(apple, queries);
    assert.equal(carrierQuery, "Switch to Carrier X other");
    assert.equal(appleQuery, "iPhone phone");
  });

  it("rejects a carrier payload that is not the five page numbers", () => {
    assert.equal(parseCarrierFacts(null), null);
    assert.equal(parseCarrierFacts({ currentMonthlyCents: 8_000 }), null);
    assert.equal(parseCarrierFacts({ ...CARRIER_WAIT, feeCents: 1.5 }), null);
    assert.equal(parseCarrierFacts({ ...CARRIER_WAIT, balanceCents: -1 }), null);
    assert.deepEqual(parseCarrierFacts(CARRIER_PASS), CARRIER_PASS);
  });
});

describe("carrier switch on the cart route", () => {
  it("keeps a carrier wait locked when the plan price is under the $40 pause floor", async () => {
    const underFloor: CarrierFacts = {
      currentMonthlyCents: 8_000,
      newMonthlyCents: 3_500,
      balanceCents: 36_000,
      monthsLeft: 12,
      feeCents: 12_000,
    };
    assert.equal(underFloor.newMonthlyCents < 4_000, true);
    assert.equal(carrierVerdict(underFloor), "wait");
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: false,
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
      const created = await post(base, "/api/carts", {
        userId: "user-floor",
        itemNames: ["Switch to Carrier X"],
        totalCents: underFloor.newMonthlyCents,
        parsed: true,
        pageHost: "127.0.0.1",
        demo: false,
        carrier: underFloor,
      });
      assert.equal(created.status, 201);
      const cart = created.body as CartSnap;
      assert.equal(cart.totalCents, 3_500);
      assert.equal(cart.necessity, "unnecessary");
      assert.equal(cart.status, "locked");
      assert.equal(cart.isUnlocked, false);
      assert.equal(
        cart.carrierLine,
        "You'd pay $360 left on the phone plus a $120 fee to save $45 a month. That takes 11 months to break even. 12 months are left on the phone.",
      );
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps decide() and blocks the wait case", async () => {
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: false,
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
      const created = await post(base, "/api/carts", {
        userId: "user-carrier",
        itemNames: ["Switch to Carrier X"],
        totalCents: CARRIER_WAIT.newMonthlyCents,
        parsed: true,
        pageHost: "127.0.0.1",
        demo: false,
        carrier: CARRIER_WAIT,
      });
      assert.equal(created.status, 201);
      const cart = created.body as CartSnap;
      assert.equal(cart.isUnlocked, false);
      assert.equal(cart.status, "locked");
      assert.equal(cart.necessity, "unnecessary");
      assert.equal(cart.carrierLine, carrierSentence(CARRIER_WAIT));
      assert.equal(cart.impulse?.score1to8, 4.5);
      assert.equal(cart.impulse?.why ?? null, null);
      assert.deepEqual(cart.decision, decide(withCartFacts({}, CARRIER_WAIT.newMonthlyCents)));
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("unlocks the pass case and does not let a later necessity read lock it again", async () => {
    let grokCalls = 0;
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: false,
      agentHandle: null,
      photon: null,
      xaiApiKey: "test-key",
      xaiModel: "grok-4.20-0309-non-reasoning",
      xaiTimeoutMs: 8_000,
      fetchImpl: () => {
        grokCalls += 1;
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content: '{"necessary": false, "reason": "Want."}' } }],
          }),
        );
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
      const created = await post(base, "/api/carts", {
        userId: "user-carrier",
        itemNames: ["Switch to Carrier X"],
        totalCents: CARRIER_PASS.newMonthlyCents,
        parsed: true,
        pageHost: "127.0.0.1",
        demo: false,
        carrier: CARRIER_PASS,
      });
      assert.equal(created.status, 201);
      const cart = created.body as CartSnap;
      assert.equal(cart.isUnlocked, true);
      assert.equal(cart.status, "unlocked");
      assert.equal(cart.necessity, "necessary");
      assert.equal(cart.carrierLine, carrierSentence(CARRIER_PASS));
      assert.equal(cart.impulse?.score1to8, 4.5);
      assert.deepEqual(cart.decision, decide(withCartFacts({}, CARRIER_PASS.newMonthlyCents)));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const again = (await (await fetch(`${base}/api/carts/${cart.code}`)).json()) as CartSnap;
      assert.equal(again.isUnlocked, true);
      assert.equal(again.necessity, "necessary");
      assert.equal(again.carrierLine, carrierSentence(CARRIER_PASS));
      assert.equal(grokCalls, 0);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a carrier wait under $40 locked on a second post, and a pass stays unlocked", async () => {
    const underFloor: CarrierFacts = {
      currentMonthlyCents: 8_000,
      newMonthlyCents: 3_500,
      balanceCents: 36_000,
      monthsLeft: 12,
      feeCents: 12_000,
    };
    const store = createMemoryStore();
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
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const waitBody = {
        userId: "user-repost",
        itemNames: ["Switch to Carrier X"],
        totalCents: underFloor.newMonthlyCents,
        parsed: true,
        pageHost: "127.0.0.1",
        demo: false,
        carrier: underFloor,
      };
      const created = await post(base, "/api/carts", waitBody);
      assert.equal(created.status, 201);
      const cart = created.body as CartSnap;
      assert.equal(cart.status, "locked");
      assert.equal(cart.isUnlocked, false);
      const stored = store.getCart(cart.code);
      assert.ok(stored);
      stored.necessity = null;
      stored.necessitySource = null;
      stored.necessityReason = null;
      store.saveCart(stored);
      const again = await post(base, "/api/carts", waitBody);
      assert.equal(again.status, 200);
      const replay = again.body as CartSnap;
      assert.equal(replay.code, cart.code);
      assert.equal(replay.necessity, "unnecessary");
      assert.equal(replay.status, "locked");
      assert.equal(replay.isUnlocked, false);
      assert.match(replay.carrierLine ?? "", /\$360 left on the phone/);

      const passBody = {
        userId: "user-repost-pass",
        itemNames: ["Switch to Carrier X"],
        totalCents: CARRIER_PASS.newMonthlyCents,
        parsed: true,
        pageHost: "127.0.0.1",
        demo: false,
        carrier: CARRIER_PASS,
      };
      const passed = await post(base, "/api/carts", passBody);
      assert.equal(passed.status, 201);
      const open = passed.body as CartSnap;
      assert.equal(open.status, "unlocked");
      assert.equal(open.isUnlocked, true);
      const storedPass = store.getCart(open.code);
      assert.ok(storedPass);
      storedPass.necessity = null;
      storedPass.necessitySource = null;
      storedPass.necessityReason = null;
      store.saveCart(storedPass);
      const passedAgain = await post(base, "/api/carts", passBody);
      assert.equal(passedAgain.status, 200);
      const stillOpen = passedAgain.body as CartSnap;
      assert.equal(stillOpen.code, open.code);
      assert.equal(stillOpen.necessity, "necessary");
      assert.equal(stillOpen.status, "unlocked");
      assert.equal(stillOpen.isUnlocked, true);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

type CartSnap = {
  code: string;
  status: string;
  isUnlocked: boolean;
  totalCents?: number;
  necessity: string | null;
  carrierLine?: string | null;
  impulse?: { score1to8: number; why: string | null } | null;
  decision: unknown;
};

const SCORE_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let scoreMongo: { mongod: MongoMemoryServer; userId: string } | null = null;

after(async () => {
  if (!scoreMongo) {
    return;
  }
  await mongoose.disconnect();
  await scoreMongo.mongod.stop();
  scoreMongo = null;
});

async function scoreQuery(cart: Cart, queries: string[]): Promise<string> {
  if (!scoreMongo) {
    const mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
    const user = await User.create({
      email: "carrier-score@example.com",
      passwordHash: SCORE_HASH,
      hourlyRate: 30,
      weeklyBudget: 500,
      backboardAssistantId: "asst-carrier-score",
    });
    scoreMongo = { mongod, userId: user.id };
  }
  const userId = scoreMongo.userId;
  cart.userId = userId;
  const start = queries.length;
  await readingForCart(userId, cart, {
    backboardEnabled: true,
    client: scriptedScoreClient(async (_assistantId, query) => {
      queries.push(query);
      return [];
    }),
  });
  return queries[start] ?? "";
}

function strictReading(why: string): CartReading {
  return {
    impulse: { score1to8: 7, band: "strict", why },
    hoursOfWork: null,
    hoursOfWorkText: null,
    legacyImpulse: 1,
  };
}

function scriptedScoreClient(
  search: (assistantId: string, query: string, limit: number) => Promise<MemorySearchHit[]>,
): BackboardClient {
  return {
    async createAssistant() {
      return { assistantId: "asst-carrier-score" };
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

function post(base: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}
