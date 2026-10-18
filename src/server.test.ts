import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createApp, type RunningApp } from "./app.js";
import { createMemoryStore } from "./store.js";

type CartBody = {
  code: string;
  status: string;
  isUnlocked: boolean;
  totalCents: number;
  parsedFromPage: boolean;
  demo: boolean;
  lockEndsAt: string;
  createdAt: string;
  vaultUntil: string | null;
  smsLink: string | null;
  linkMessage: string | null;
  deskPath: string;
  synthetic: boolean;
  decision: { action: string; savingsCents: number } | null;
  explanation: string | null;
  lastPing: { delivered: boolean; reason: string | null; qrDataUrl: string | null; smsLink: string | null } | null;
  items: { name: string }[];
};

type GateBody = { ok: boolean; reason: string | null; isUnlocked: boolean; httpStatus: number };
type Transcript = { turns: { role: string; text: string }[]; reading: boolean };

describe("apple bag lock", () => {
  let base = "";
  let running: RunningApp;
  let close: () => Promise<void>;

  before(async () => {
    running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 80,
      demoDefault: false,
      agentHandle: "+15550001111",
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

  it("locks a parsed bag, rejects pay until unlock, and does not place an order", async () => {
    const config = (await get("/api/config")) as { channel: string; lockMs: number; fallbackTotalCents: number };
    assert.equal(config.channel, "stub");
    assert.equal(config.lockMs, 600_000);
    assert.equal(config.fallbackTotalCents, 120_000);

    const fallback = await post("/api/carts", { userId: "user-fallback", parsed: false, demo: true });
    assert.equal(fallback.status, 201);
    const example = fallback.body as CartBody;
    assert.equal(example.parsedFromPage, false);
    assert.equal(example.totalCents, 120_000);
    assert.equal(example.items[0]?.name, "Example phone");
    assert.equal(example.lastPing?.delivered, false);
    assert.match(example.lastPing?.qrDataUrl ?? "", /^data:image\/png;base64,/);

    const created = await post("/api/carts", {
      userId: "user-demo1",
      itemNames: ["iPhone 16 Pro"],
      totalCents: 119_900,
      parsed: true,
      pageHost: "www.apple.com",
      demo: true,
    });
    assert.equal(created.status, 201);
    const cart = created.body as CartBody;
    assert.equal(cart.status, "locked");
    assert.equal(cart.isUnlocked, false);
    assert.equal(cart.totalCents, 119_900);
    assert.equal(cart.decision?.action, "sleep");
    assert.equal(new Date(cart.lockEndsAt).getTime() - new Date(cart.createdAt).getTime(), 600_000);
    assert.match(cart.smsLink ?? "", /AB|sms:/);
    assert.equal(cart.linkMessage, "link user-demo1");

    const again = await post("/api/carts", {
      userId: "user-demo1",
      itemNames: ["iPhone 16 Pro"],
      totalCents: 119_900,
      parsed: true,
      pageHost: "www.apple.com",
    });
    assert.equal((again.body as CartBody).code, cart.code);

    const blocked = await post("/api/pay", { code: cart.code });
    assert.equal(blocked.status, 423);
    assert.equal((blocked.body as GateBody).reason, "locked");
    assert.equal((blocked.body as GateBody).isUnlocked, false);

    const unlocked = await post(`/api/carts/${cart.code}/unlock`, {});
    assert.equal(unlocked.status, 200);
    assert.equal((unlocked.body as CartBody).status, "unlocked");
    const open = await post("/api/pay", { code: cart.code });
    assert.equal(open.status, 200);
    assert.equal((open.body as GateBody).ok, true);
    const still = (await get(`/api/carts/${cart.code}`)) as CartBody;
    assert.equal(still.status, "unlocked");
  });

  it("vaults the bag for 24 hours, skips in demo, and pings a linked desk thread", async () => {
    const created = await post("/api/carts", {
      userId: "user-vault1",
      itemNames: ["iPhone 16 Pro"],
      totalCents: 119_900,
      parsed: true,
      pageHost: "www.apple.com",
      demo: true,
    });
    const cart = created.body as CartBody;
    const slept = await post(`/api/carts/${cart.code}/sleep`, {});
    const vault = slept.body as CartBody;
    assert.equal(vault.status, "vault");
    assert.equal(new Date(vault.vaultUntil ?? "").getTime() - Date.now() > 23 * 60 * 60 * 1000, true);
    const held = await post("/api/pay", { code: cart.code });
    assert.equal((held.body as GateBody).reason, "vault");
    const refused = await post(`/api/carts/${cart.code}/unlock`, {});
    assert.equal(refused.status, 423);

    const skipped = await post(`/api/carts/${cart.code}/skip-vault`, {});
    assert.equal((skipped.body as CartBody).status, "locked");
    const relocked = await post("/api/pay", { code: cart.code });
    assert.equal((relocked.body as GateBody).reason, "locked");

    const conversationId = `desk:cart-${cart.code}`;
    const linked = await post("/api/dev/link", { userId: "user-vault1", conversationId });
    assert.equal(linked.status, 200);
    const ping = await post(`/api/carts/${cart.code}/notify`, { fail: false });
    assert.equal((ping.body as CartBody).lastPing?.delivered, true);
    const thread = (await get(`/api/dev/messages?conversationId=${conversationId}`)) as Transcript;
    assert.match(thread.turns.map((turn) => turn.text).join("\n"), /paused your/);

    const failed = await post(`/api/carts/${cart.code}/notify`, { fail: true });
    assert.equal((failed.body as CartBody).lastPing?.delivered, false);
    assert.equal((failed.body as CartBody).lastPing?.reason, "send_failed");
    assert.ok((failed.body as CartBody).lastPing?.qrDataUrl);

    await post("/api/dev/messages", {
      conversationId,
      text: `cart ${cart.code} my battery dies by 3pm and I owe $420`,
    });
    const after = (await get(`/api/carts/${cart.code}`)) as CartBody;
    assert.match(after.explanation ?? "", /keywords/);
    assert.match(after.explanation ?? "", /^Waiting /);

    await post("/api/dev/messages", { conversationId, text: "sleep" });
    await delay(200);
    const reminded = (await get(`/api/dev/messages?conversationId=${conversationId}`)) as Transcript;
    assert.match(reminded.turns.map((turn) => turn.text).join("\n"), /Desk:/);

    const fallback = await fetch(`${base}/fallback`);
    assert.equal(fallback.status, 200);
    const html = await fallback.text();
    assert.match(html, /Example phone/);
    assert.match(html, /Bag Subtotal/);
    assert.match(html, /\$1,200\.00/);
    assert.match(html, /Check Out/);
    assert.doesNotMatch(html, /Visa/);
  });

  async function get(path: string): Promise<unknown> {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.ok, true);
    return response.json() as Promise<unknown>;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as unknown;
    return { status: response.status, body: parsed };
  }
});
