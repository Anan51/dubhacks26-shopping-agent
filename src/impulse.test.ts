import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createApp } from "./app.js";
import { isEnforcedVault, itemsForBag, liftCart, sleepCart, startLockedCart, unlockCart, withCartFacts } from "./carts.js";
import { createMemoryStore } from "./store.js";
import { decide } from "./heuristic.js";
import { DELIBERATE, IMPULSIVE, personaFor } from "./history.js";
import {
  applyPurchaseScore,
  classifyNecessity,
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

  it("uses Grok when the JSON is valid and keywords when the call fails", async () => {
    let calls = 0;
    const grok = await classifyNecessity("Example phone", {
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          choices: [{ message: { content: '{"necessary": false, "reason": "Upgrade."}' } }],
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(grok.source, "grok");
    assert.equal(grok.necessary, false);
    assert.equal(locksCheckout(grok), true);

    const broken = await classifyNecessity("USB-C charge cable", {
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ choices: [{ message: { content: "nope" } }] }),
    });
    assert.equal(broken.source, "keywords");
    assert.equal(broken.necessary, true);

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
    assert.match(held.reply, /24 hours/);
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
      assert.match(freed.explanation ?? "", /will not click it/);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("checkout ping and a low score", () => {
  it("pings an unnecessary bag once, keeps a score of 3 locked, and ignores a repeat post", async () => {
    const store = createMemoryStore();
    store.savePhoneLink({
      userId: "user-low",
      conversationId: "desk:low-bag-ping",
      linkedAt: "2026-10-18T00:00:00.000Z",
    });
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
    const phone = {
      userId: "user-low",
      itemNames: ["Example phone"],
      totalCents: 120_000,
      parsed: true,
      demo: true,
    };
    try {
      const created = await post(base, "/api/carts", phone);
      const locked = created.body as CartSnap;
      assert.equal(created.status, 201);
      assert.equal(locked.necessity, "unnecessary");
      assert.equal(locked.isUnlocked, false);
      assert.equal(locked.status, "locked");
      assert.equal(locked.lastPing && typeof locked.lastPing === "object" ? (locked.lastPing as { delivered: boolean }).delivered : null, true);

      const stored = store.getCart(locked.code);
      assert.ok(stored);
      stored.impulse = { score1to8: 3, band: "free", why: null };
      stored.userImpulseScore = 4;
      store.saveCart(stored);
      const low = (await get(base, `/api/carts/${locked.code}`)) as CartSnap;
      assert.equal(low.impulse?.score1to8, 3);
      assert.equal(low.isUnlocked, false);
      assert.equal(low.status, "locked");

      const again = await post(base, "/api/carts", phone);
      const replay = again.body as CartSnap;
      assert.equal(again.status, 200);
      assert.equal(replay.code, locked.code);
      assert.equal(replay.isUnlocked, false);
      assert.equal(replay.status, "locked");

      const thread = (await get(base, "/api/dev/messages?conversationId=desk:low-bag-ping")) as {
        turns: { role: string; text: string }[];
      };
      const pings = thread.turns.filter((turn) => turn.role === "agent" && turn.text.includes("paused your"));
      assert.equal(pings.length, 1);

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

function cart() {
  return startLockedCart({
    items: itemsForBag(["Example phone"], 120_000, false),
    totalCents: 120_000,
    parsedFromPage: false,
    pageHost: "127.0.0.1",
    fingerprint: "user|120000|example phone",
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
};

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
