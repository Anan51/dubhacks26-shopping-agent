import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleWebhook } from "../api/webhook.js";
import { noteDelivery } from "./channels/photon.js";
import { itemsForBag, startLockedCart } from "./carts.js";
import { createRuntime } from "./runtime.js";
import { createMemoryStore } from "./store.js";

const NOW = new Date("2026-10-18T00:00:00.000Z");
const SPACE = "pho_spc_00000000000000000000000000";
const AGENT = "+15550001111";

describe("failed send is not acknowledged", () => {
  it("answers 5xx, keeps the cart locked, then accepts the same id when send works", async () => {
    const store = createMemoryStore();
    const cart = startLockedCart({
      items: itemsForBag(["Example phone"], 120_000, true),
      totalCents: 120_000,
      parsedFromPage: true,
      pageHost: "www.apple.com",
      fingerprint: "user-impulsive|120000|example phone|webhook",
      now: NOW,
      demo: true,
      lockMs: 600_000,
      userId: "user-impulsive",
      code: "QR34ST",
    });
    cart.necessity = "unnecessary";
    cart.userImpulseScore = 2;
    store.saveCart(cart);
    store.savePhoneLink({
      userId: "user-impulsive",
      conversationId: SPACE,
      linkedAt: NOW.toISOString(),
    });
    let attempts = 0;
    const runtime = createRuntime({
      store,
      now: () => NOW,
      demoReminderMs: 60_000,
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("photon down bearer super-secret-token");
        }
      },
      armReminder: () => undefined,
      disarmReminder: () => undefined,
      polish: async (template) => template,
    });
    const previous = snapshotEnv();
    process.env.PHOTON_WEBHOOK_SECRET = "whsec_test";
    process.env.PHOTON_API_KEY = "pho_sk_example";
    process.env.PHOTON_PROJECT_ID = "pho_prj_example";
    process.env.PHOTON_PLATFORM = "imessage";
    process.env.PHOTON_AGENT_HANDLE = AGENT;
    try {
      const failed = await postWebhook(runtime);
      assert.equal(failed.status, 500);
      assert.equal(store.getCart("QR34ST")?.replied, false);
      assert.equal(store.getCart("QR34ST")?.isUnlocked, false);
      assert.equal(store.getCart("QR34ST")?.status, "locked");
      assert.equal(store.hasHandledInbound("pho_msg_retry"), false);
      assert.equal(store.getSession(SPACE)?.turns.length ?? 0, 0);

      const retried = await postWebhook(runtime);
      assert.equal(retried.status, 200);
      assert.equal((retried.body as { action: string }).action, "reply");
      const saved = store.getCart("QR34ST");
      const turns = store.getSession(SPACE)?.turns ?? [];
      assert.equal(attempts, 2);
      assert.equal(saved?.replied, true);
      assert.equal(saved?.isUnlocked, false);
      assert.equal(saved?.status, "locked");
      assert.equal(turns.filter((turn) => turn.role === "shopper").length, 1);
      assert.equal(turns.filter((turn) => turn.role === "agent").length, 1);
    } finally {
      restoreEnv(previous);
    }
  });

  it("does not advance the listener cursor when handling throws", async () => {
    let cursor = 4;
    await assert.rejects(
      async () => {
        cursor = await noteDelivery(cursor, 5, async () => {
          throw new Error("iMessage send failed.");
        });
      },
      /iMessage send failed/,
    );
    assert.equal(cursor, 4);

    cursor = await noteDelivery(cursor, 5, async () => undefined);
    assert.equal(cursor, 5);
    cursor = await noteDelivery(cursor, 5, async () => {
      throw new Error("should not run");
    });
    assert.equal(cursor, 5);
  });
});

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, previous);
}

async function postWebhook(runtime: ReturnType<typeof createRuntime>): Promise<{ status: number; body: unknown }> {
  const req = {
    method: "POST",
    body: inboundEvent(),
  } as IncomingMessage & { body?: unknown };
  let status = 0;
  let raw = "";
  const res = {
    get statusCode() {
      return status;
    },
    set statusCode(value: number) {
      status = value;
    },
    setHeader() {
      return undefined;
    },
    end(payload: string) {
      raw = payload;
    },
  } as unknown as ServerResponse;
  await handleWebhook(req, res, runtime);
  return { status, body: JSON.parse(raw) as unknown };
}

function inboundEvent(): unknown {
  return {
    id: "pho_evt_00000000000000000000000000",
    type: "message.received",
    apiVersion: "2026-07-01",
    source: "imessage.photon",
    timestamp: "2026-10-18T00:00:00.000Z",
    data: {
      projectId: "pho_prj_example",
      object: {
        id: "pho_msg_retry",
        platform: "imessage",
        status: "received",
        space: { id: SPACE, platform: "imessage", kind: "direct" },
        sentBy: {
          id: "pho_usr_00000000000000000000000001",
          platform: "imessage",
          kind: "human",
          handle: "shopper@example.com",
        },
        receivedBy: {
          id: "pho_usr_00000000000000000000000002",
          platform: "imessage",
          kind: "agent",
          handle: AGENT,
        },
        content: { type: "text", format: "plain", text: "the new color looks nice" },
      },
    },
  };
}
