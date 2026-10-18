import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createApp } from "../app.js";
import { itemsForBag, startLockedCart, withCartFacts } from "../carts.js";
import { decide } from "../heuristic.js";
import { createMemoryStore } from "../store.js";
import { applyImpulseReading, type CartReading } from "./cartReading.js";
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

  it("rejects a carrier payload that is not the five page numbers", () => {
    assert.equal(parseCarrierFacts(null), null);
    assert.equal(parseCarrierFacts({ currentMonthlyCents: 8_000 }), null);
    assert.equal(parseCarrierFacts({ ...CARRIER_WAIT, feeCents: 1.5 }), null);
    assert.equal(parseCarrierFacts({ ...CARRIER_WAIT, balanceCents: -1 }), null);
    assert.deepEqual(parseCarrierFacts(CARRIER_PASS), CARRIER_PASS);
  });
});

describe("carrier switch on the cart route", () => {
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
});

type CartSnap = {
  code: string;
  status: string;
  isUnlocked: boolean;
  necessity: string | null;
  carrierLine?: string | null;
  impulse?: { score1to8: number; why: string | null } | null;
  decision: unknown;
};

function strictReading(why: string): CartReading {
  return {
    impulse: { score1to8: 7, band: "strict", why },
    hoursOfWork: null,
    hoursOfWorkText: null,
    legacyImpulse: 1,
  };
}

function post(base: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}
