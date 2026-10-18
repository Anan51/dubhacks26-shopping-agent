import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import type { OutboundMessage } from "./channel.js";
import type { PhotonChannel } from "./channels/photon.js";
import { createApp } from "./app.js";
import { DEMO_REPLY_PRESETS, type DemoReplyPreset } from "./demo-reply-presets.js";
import { createMemoryStore, type Store } from "./store.js";

const PHOTON_SPACE = "pho_spc_00000000000000000000000000";

type ReplyCart = {
  code: string;
  status: string;
  isUnlocked: boolean;
  replied: boolean;
  advice: string | null;
  explanation: string | null;
  purchaseScore: number | null;
  scoreBucket: string | null;
  justificationGrade: number | null;
  gradeSource: string | null;
  vaultUntil: string | null;
  necessity: string | null;
  totalCents: number;
  userImpulseScore: number | null;
  impulse: { score1to8: number; band: string; why: string | null } | null;
  decision: { action: string } | null;
};

type ExpectedReply = {
  justificationGrade: number | null;
  purchaseScore: number | null;
  scoreBucket: string | null;
  advice: string;
  impulsivenessLine: boolean;
};

const EXPECTED: Record<DemoReplyPreset, ExpectedReply> = {
  "new color looks nice": {
    justificationGrade: -2,
    purchaseScore: 1,
    scoreBucket: "strict",
    advice: "Skip. This looks like a want, not a need.",
    impulsivenessLine: true,
  },
  "cracked screen": {
    justificationGrade: null,
    purchaseScore: null,
    scoreBucket: null,
    advice: "Wait. Your current phone is broken.",
    impulsivenessLine: false,
  },
  "I need it for work tomorrow": {
    justificationGrade: 2,
    purchaseScore: 4,
    scoreBucket: "free",
    advice: "Buy. This looks like a need.",
    impulsivenessLine: true,
  },
};

async function listen(input: {
  env: NodeJS.ProcessEnv;
  store?: Store;
  photon?: PhotonChannel | null;
}): Promise<{ base: string; runtime: ReturnType<typeof createApp>["runtime"]; close: () => Promise<void> }> {
  const running = createApp({
    store: input.store ?? createMemoryStore(),
    origin: "http://127.0.0.1",
    lockMs: 600_000,
    demoReminderMs: 60_000,
    demoDefault: true,
    agentHandle: null,
    photon: input.photon ?? null,
    xaiModel: "grok-4.20-0309-non-reasoning",
    xaiTimeoutMs: 8_000,
    polish: async (template) => template,
    env: input.env,
  });
  const server = createServer(running.app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    runtime: running.runtime,
    close: () =>
      new Promise((resolve, reject) => {
        running.scheduler.stop();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: ReplyCart & { error?: string } }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ReplyCart & { error?: string } };
}

describe("simulated reply", () => {
  it("returns 404 when demo mode is off, including production", async () => {
    const off = await listen({ env: { NODE_ENV: "test" } });
    const production = await listen({ env: { NODE_ENV: "production", WAITMATE_DEMO: "1" } });
    try {
      const hidden = await post(off.base, "/api/dev/reply", { code: "AB23CD", text: "new color looks nice" });
      assert.equal(hidden.status, 404);
      const blocked = await post(production.base, "/api/dev/reply", { code: "AB23CD", text: "cracked screen" });
      assert.equal(blocked.status, 404);
    } finally {
      await off.close();
      await production.close();
    }
  });

  it("grades presets through the inbound path and does not call Photon for a simulated reply", async () => {
    const sent: string[] = [];
    const photon = {
      onDelivery: () => undefined,
      send: async (message: OutboundMessage) => {
        sent.push(message.conversationId);
      },
    } as unknown as PhotonChannel;
    const store = createMemoryStore();
    const demo = await listen({ env: { NODE_ENV: "test", WAITMATE_DEMO: "1" }, store, photon });
    try {
      const cable = await post(demo.base, "/api/carts", {
        userId: "user-cable",
        itemNames: ["USB-C charge cable"],
        totalCents: 1_900,
        parsed: true,
        demo: true,
      });
      assert.equal(cable.status, 201);
      assert.equal(cable.body.necessity, "necessary");
      assert.equal(cable.body.isUnlocked, true);
      assert.equal(cable.body.status, "unlocked");
      assert.equal(Number.isInteger(cable.body.totalCents), true);

      const phone = {
        itemNames: ["Example phone"],
        totalCents: 119_900,
        parsed: true,
        demo: true,
      };
      const results = new Map<DemoReplyPreset, ReplyCart>();
      for (const [index, preset] of DEMO_REPLY_PRESETS.entries()) {
        const created = await post(demo.base, "/api/carts", { ...phone, userId: `user-preset-${index}` });
        assert.equal(created.status, 201);
        assert.equal(created.body.isUnlocked, false);
        const code = created.body.code;
        const stored = store.getCart(code);
        assert.ok(stored);
        stored.conversationId = PHOTON_SPACE;
        store.saveCart(stored);
        const denied = await post(demo.base, `/api/carts/${code}/unlock`, {});
        assert.equal(denied.status, 403);
        const simulated = await post(demo.base, "/api/dev/reply", { code, text: preset });
        assert.equal(simulated.status, 200);
        results.set(preset, simulated.body);
      }

      assert.deepEqual(sent, []);

      for (const preset of DEMO_REPLY_PRESETS) {
        const body = results.get(preset);
        const want = EXPECTED[preset];
        assert.ok(body);
        assert.equal(body.replied, true, preset);
        assert.equal(body.isUnlocked, false, preset);
        assert.equal(body.status, "locked", preset);
        assert.equal(body.vaultUntil, null, preset);
        assert.equal(body.justificationGrade, want.justificationGrade, preset);
        assert.equal(body.purchaseScore, want.purchaseScore, preset);
        assert.equal(body.scoreBucket, want.scoreBucket, preset);
        assert.equal(body.gradeSource, want.justificationGrade === null ? null : "keywords", preset);
        assert.equal(body.advice, want.advice, preset);
        assert.equal(body.advice?.includes("Impulsiveness"), false, preset);
        assert.equal(body.userImpulseScore, 2, preset);
        assert.equal(body.impulse?.score1to8, 4.5, preset);
        assert.equal(body.impulse?.band, "soft", preset);
        assert.equal((body.explanation ?? "").includes("Impulsiveness 4.5 of 8"), want.impulsivenessLine, preset);
        assert.equal(Number.isInteger(body.totalCents), true);
        const pay = await post(demo.base, "/api/pay", { code: body.code });
        assert.equal(pay.status, 423, preset);
      }

      const typed = await post(demo.base, "/api/carts", { ...phone, userId: "user-typed" });
      const typedReply = await post(demo.base, "/api/dev/reply", { code: typed.body.code, text: "I need it for work" });
      assert.equal(typedReply.status, 200);
      assert.equal(typedReply.body.purchaseScore, 3);
      assert.equal(typedReply.body.scoreBucket, "soft");
      assert.equal(typedReply.body.advice, "Wait. This looks like a need.");
      assert.equal(typedReply.body.isUnlocked, false);
      assert.equal(typedReply.body.replied, true);
      const empty = await post(demo.base, "/api/dev/reply", { code: typed.body.code, text: "   " });
      assert.equal(empty.status, 400);
      assert.deepEqual(sent, []);

      const mirrorUser = "user-mirror";
      const mirror = await post(demo.base, "/api/carts", { ...phone, userId: mirrorUser });
      store.savePhoneLink({
        userId: mirrorUser,
        conversationId: PHOTON_SPACE,
        linkedAt: "2026-10-18T00:00:00.000Z",
      });
      await demo.runtime.enqueue({
        id: "pho_msg_mirror_color",
        conversationId: PHOTON_SPACE,
        text: "new color looks nice",
        agentSenderId: "pho_usr_agent",
      });
      const mirrored = store.getCart(mirror.body.code);
      const simulated = results.get("new color looks nice");
      assert.ok(mirrored);
      assert.ok(simulated);
      assert.equal(mirrored.purchaseScore, simulated.purchaseScore);
      assert.equal(mirrored.scoreBucket, simulated.scoreBucket);
      assert.equal(mirrored.justificationGrade, simulated.justificationGrade);
      assert.equal(mirrored.advice, simulated.advice);
      assert.equal(mirrored.isUnlocked, false);
      assert.equal(mirrored.status, "locked");
      assert.deepEqual(sent, [PHOTON_SPACE]);
    } finally {
      await demo.close();
    }
  });
});
