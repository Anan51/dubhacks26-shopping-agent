import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createApp } from "../app.js";
import { createMemoryStore } from "../store.js";

describe("nudge hook", () => {
  it("personalizes with the authenticated Mongo id and leaves the demo path unchanged without the hook", async () => {
    const seen: string[] = [];
    const hooked = await listen(createApp({
      ...demoDeps(),
      readSession: async () => ({ id: "mongo-user", email: "ada@example.com" }),
      personalizeNudge: async (text, authenticatedUserId) => {
        seen.push(authenticatedUserId);
        return `${text}\n\nYour goal: save up.`;
      },
    }));
    const created = await post(hooked.base, "/api/carts", {
      userId: "shopper-demo",
      itemNames: ["iPhone 16 Pro"],
      totalCents: 119_900,
      parsed: true,
      demo: true,
    });
    const body = created.body as { explanation: string | null };
    assert.equal(created.status, 201);
    assert.match(body.explanation ?? "", /Your goal: save up/);
    assert.deepEqual(seen, ["mongo-user"]);
    await hooked.close();

    const plain = await listen(createApp(demoDeps()));
    const untouched = await post(plain.base, "/api/carts", {
      userId: "shopper-demo",
      itemNames: ["iPhone 16 Pro"],
      totalCents: 119_900,
      parsed: true,
      demo: true,
    });
    const plainBody = untouched.body as { explanation: string | null };
    assert.equal(plainBody.explanation?.includes("Your goal"), false);
    await plain.close();
  });
});

function demoDeps() {
  return {
    store: createMemoryStore(),
    origin: "http://127.0.0.1",
    lockMs: 600_000,
    demoReminderMs: 60_000,
    demoDefault: false,
    agentHandle: null,
    photon: null,
    xaiModel: "grok-4.20-0309-non-reasoning",
    xaiTimeoutMs: 8_000,
    polish: async (template: string) => template,
  };
}

async function listen(running: ReturnType<typeof createApp>): Promise<{ base: string; close: () => Promise<void> }> {
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
  return { status: response.status, body: await response.json() };
}
