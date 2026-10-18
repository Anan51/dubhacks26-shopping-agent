import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createApp } from "./app.js";
import { createMemoryStore } from "./store.js";

async function listen(env: NodeJS.ProcessEnv): Promise<{ base: string; close: () => Promise<void> }> {
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
    env,
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

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("dev routes", () => {
  it("unlocks only when the dev flag is set outside production", async () => {
    const locked = await listen({ NODE_ENV: "test" });
    const open = await listen({ NODE_ENV: "test", WAITMATE_DEV_UNLOCK: "1" });
    const production = await listen({ NODE_ENV: "production", WAITMATE_DEV_UNLOCK: "1" });
    try {
      const bag = {
        userId: "user-demo1",
        itemNames: ["iPhone 16 Pro"],
        totalCents: 119_900,
        parsed: true,
        demo: true,
      };
      const created = await post(open.base, "/api/carts", bag);
      const code = (created.body as { code: string }).code;
      const unlocked = await post(open.base, `/api/carts/${code}/unlock`, {});
      assert.equal(unlocked.status, 200);
      assert.equal((unlocked.body as { status: string }).status, "unlocked");

      const held = await post(locked.base, "/api/carts", bag);
      const heldCode = (held.body as { code: string }).code;
      const denied = await post(locked.base, `/api/carts/${heldCode}/unlock`, {});
      assert.equal(denied.status, 403);

      const prodCart = await post(production.base, "/api/carts", bag);
      const prodCode = (prodCart.body as { code: string }).code;
      const prodUnlock = await post(production.base, `/api/carts/${prodCode}/unlock`, {});
      assert.equal(prodUnlock.status, 403);
      const messages = await post(production.base, "/api/dev/messages", {
        conversationId: `desk:cart-${prodCode}`,
        text: "hello",
      });
      assert.equal(messages.status, 200);
      const demoOff = await post(locked.base, "/api/dev/reply", { code: heldCode, text: "hello" });
      assert.equal(demoOff.status, 403);
      const demoOn = await listen({ NODE_ENV: "test", WAITMATE_DEMO: "1" });
      try {
        const made = await post(demoOn.base, "/api/carts", bag);
        const demoCode = (made.body as { code: string }).code;
        const simulated = await post(demoOn.base, "/api/dev/reply", { code: demoCode, text: "the new color looks nice" });
        assert.equal(simulated.status, 200);
        const body = simulated.body as { replied: boolean; isUnlocked: boolean; advice: string | null };
        assert.equal(body.replied, true);
        assert.equal(body.isUnlocked, false);
        assert.match(body.advice ?? "", /^(Buy|Wait|Skip)\./);
      } finally {
        await demoOn.close();
      }
      const blocked = await listen({ NODE_ENV: "production" });
      try {
        const noFlag = await post(blocked.base, "/api/dev/reset", {});
        assert.equal(noFlag.status, 403);
      } finally {
        await blocked.close();
      }
    } finally {
      await locked.close();
      await open.close();
      await production.close();
    }
  });
});
