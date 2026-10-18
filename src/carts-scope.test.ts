import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { createApp, type RunningApp } from "./app.js";
import { readOptionalUser, signSession } from "./auth/session.js";
import { createMemoryStore } from "./store.js";

const SECRET = "cart-scope-test-jwt-secret".padEnd(32, "x");
const DEVICE = "user-device-a";
let base = "";

type ListedCart = { code: string; userId: string | null; authUserId?: string; items: { name: string }[] };

describe("cart account scope", () => {
  let running: RunningApp;
  let close: () => Promise<void>;
  let tokenA = "";
  let tokenB = "";

  before(async () => {
    tokenA = await signSession({ id: "account-a", email: "a@example.com" }, SECRET);
    tokenB = await signSession({ id: "account-b", email: "b@example.com" }, SECRET);
    running = createApp({
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
      readSession: (req) => readOptionalUser(req, SECRET),
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    close = () =>
      new Promise((resolve, reject) => {
        running.scheduler.stop();
        server.close((error) => (error ? reject(error) : resolve()));
      });
  });

  after(async () => {
    await close();
  });

  it("returns a signed-in cart only to that account, including after logout", async () => {
    const anon = await post("/api/carts", {
      userId: "user-anon-demo",
      itemNames: ["USB-C Charge Cable"],
      totalCents: 1_900,
      parsed: true,
      demo: true,
    });
    assert.equal(anon.status, 201);
    const anonCart = anon.body as ListedCart;
    assert.equal(anonCart.authUserId, undefined);
    assert.equal(anonCart.userId, "user-anon-demo");

    const created = await post(
      "/api/carts",
      {
        userId: DEVICE,
        itemNames: ["iPhone 16 Pro"],
        totalCents: 119_900,
        parsed: true,
        pageHost: "www.apple.com",
        demo: true,
      },
      tokenA,
    );
    assert.equal(created.status, 201);
    const cart = created.body as ListedCart;
    assert.equal(cart.authUserId, "account-a");
    assert.equal(cart.userId, DEVICE);

    const asA = await get("/api/carts", tokenA);
    assert.equal(asA.status, 200);
    assert.deepEqual(
      (asA.body.carts as ListedCart[]).map((item) => item.code),
      [cart.code],
    );

    const asB = await get("/api/carts", tokenB);
    assert.equal(asB.status, 200);
    assert.deepEqual(asB.body.carts, []);

    const mismatched = await get(`/api/carts?userId=${DEVICE}`, tokenA);
    assert.equal(mismatched.status, 403);
    assert.equal(mismatched.body.carts, undefined);

    const loggedOut = await get("/api/carts");
    assert.equal(loggedOut.status, 200);
    const loggedOutCodes = (loggedOut.body.carts as ListedCart[]).map((item) => item.code);
    assert.equal(loggedOutCodes.includes(cart.code), false);
    assert.equal(loggedOutCodes.includes(anonCart.code), true);

    const byDevice = await get(`/api/carts?userId=${DEVICE}`);
    assert.deepEqual(byDevice.body.carts, []);
    const anonList = await get("/api/carts?userId=user-anon-demo");
    assert.deepEqual(
      (anonList.body.carts as ListedCart[]).map((item) => item.code),
      [anonCart.code],
    );
  });
});

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function get(path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
