import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createApp } from "./app.js";
import { createMemoryStore } from "./store.js";

describe("sleep route", () => {
  it("accepts sleep for scores 2 and 3 and rejects 1 and 4+", async () => {
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
      env: { NODE_ENV: "test" },
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const held = await grade(base, "user-sleep-1", "the new color looks nice");
      assert.equal(held.purchaseScore, 1);
      assert.equal(held.scoreBucket, "strict");
      assert.equal((await post(base, `/api/carts/${held.code}/sleep`, {})).status, 409);

      const softLow = await grade(base, "user-sleep-2", "the new color looks nice");
      const shifted = await post(base, "/api/dev/persona", { userId: "user-sleep-2", persona: "deliberate" });
      assert.equal(shifted.status, 200);
      const softened = await fetch(`${base}/api/carts/${softLow.code}`);
      const softBody = (await softened.json()) as { code: string; purchaseScore: number | null; scoreBucket: string | null };
      assert.equal(softBody.purchaseScore, 2);
      assert.equal(softBody.scoreBucket, "soft");
      const slept = await post(base, `/api/carts/${softLow.code}/sleep`, {});
      assert.equal(slept.status, 200);
      assert.equal((slept.body as { status: string; vaultMode: string | null }).status, "vault");
      assert.equal((slept.body as { vaultMode: string | null }).vaultMode, "soft");

      const softHigh = await grade(base, "user-sleep-3", "I need it for work");
      assert.equal(softHigh.purchaseScore, 3);
      assert.equal(softHigh.scoreBucket, "soft");
      assert.equal((await post(base, `/api/carts/${softHigh.code}/sleep`, {})).status, 200);

      const free = await grade(base, "user-sleep-4", "my battery dies by 3pm");
      assert.equal(free.purchaseScore, 4);
      assert.equal(free.scoreBucket, "free");
      assert.equal((await post(base, `/api/carts/${free.code}/sleep`, {})).status, 409);
    } finally {
      running.scheduler.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

async function grade(
  base: string,
  userId: string,
  text: string,
): Promise<{ code: string; purchaseScore: number | null; scoreBucket: string | null }> {
  const created = await post(base, "/api/carts", {
    userId,
    itemNames: ["Example phone"],
    totalCents: 120_000,
    parsed: true,
    demo: true,
  });
  const code = (created.body as { code: string }).code;
  const sent = await post(base, "/api/dev/messages", { conversationId: `desk:cart-${code}`, text });
  assert.equal(sent.status, 200);
  const response = await fetch(`${base}/api/carts/${code}`);
  return (await response.json()) as { code: string; purchaseScore: number | null; scoreBucket: string | null };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
