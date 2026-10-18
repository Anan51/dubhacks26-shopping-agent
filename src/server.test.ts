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
    assert.equal(fallback.status, 422);
    assert.equal((fallback.body as { error: string }).error, "Couldn't read bag");
    const unread = (await get("/api/carts")) as { carts: CartBody[]; readError: string | null };
    assert.equal(unread.readError, "Couldn't read bag");
    assert.equal(unread.carts.some((item) => item.items[0]?.name === "Example phone"), false);

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

    const denied = await post(`/api/carts/${cart.code}/unlock`, {});
    assert.equal(denied.status, 403);
    assert.equal(((await get(`/api/carts/${cart.code}`)) as CartBody).status, "locked");
    const stillBlocked = await post("/api/pay", { code: cart.code });
    assert.equal(stillBlocked.status, 423);
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
    const conversationId = `desk:cart-${cart.code}`;
    const refusedSleep = await post(`/api/carts/${cart.code}/sleep`, {});
    assert.equal(refusedSleep.status, 409);
    assert.equal(((await get(`/api/carts/${cart.code}`)) as CartBody).status, "locked");
    const beforeReply = await post(`/api/carts/${cart.code}/unlock`, {});
    assert.equal(beforeReply.status, 403);
    await post("/api/dev/messages", { conversationId, text: "the new color looks nice" });
    const advised = (await get(`/api/carts/${cart.code}`)) as CartBody & { replied?: boolean; advice?: string | null };
    assert.equal(advised.status, "locked");
    assert.equal(advised.isUnlocked, false);
    assert.equal(advised.replied, true);
    assert.match(advised.advice ?? "", /^Skip\./);
    const held = await post("/api/pay", { code: cart.code });
    assert.equal((held.body as GateBody).reason, "locked");
    const released = await post(`/api/carts/${cart.code}/unlock`, {});
    assert.equal(released.status, 200);
    assert.equal((released.body as CartBody).isUnlocked, true);

    const linked = await post("/api/dev/link", { userId: "user-vault1", conversationId });
    assert.equal(linked.status, 200);
    const ping = await post(`/api/carts/${cart.code}/notify`, { fail: false });
    assert.equal((ping.body as CartBody).lastPing?.delivered, true);
    const thread = (await get(`/api/dev/messages?conversationId=${conversationId}`)) as Transcript;
    assert.match(thread.turns.map((turn) => turn.text).join("\n"), /paused your/);
    assert.match(thread.turns.map((turn) => turn.text).join("\n"), /What's making you want to upgrade\?/);

    const failed = await post(`/api/carts/${cart.code}/notify`, { fail: true });
    assert.equal((failed.body as CartBody).lastPing?.delivered, false);
    assert.equal((failed.body as CartBody).lastPing?.reason, "send_failed");
    assert.ok((failed.body as CartBody).lastPing?.qrDataUrl);

    await post("/api/dev/messages", {
      conversationId,
      text: `cart ${cart.code} my battery dies by 3pm and I owe $420`,
    });
    const after = (await get(`/api/carts/${cart.code}`)) as CartBody;
    assert.match(after.explanation ?? "", /Purchase score 4/);
    assert.match(after.explanation ?? "", /keywords/);

    const threadAfter = (await get(`/api/dev/messages?conversationId=${conversationId}`)) as Transcript;
    const spoken = threadAfter.turns.map((turn) => turn.text).join("\n");
    assert.doesNotMatch(spoken, /\/dev/);
    assert.doesNotMatch(spoken, /sms:/);

    const plain = await post("/api/dev/messages", {
      conversationId,
      text: "cracked screen, battery dies by 3pm, I need it for work tomorrow",
    });
    assert.equal(plain.status, 200);
    const needed = (await get(`/api/carts/${cart.code}`)) as CartBody & {
      decision: { action: string; signalEffect: string } | null;
      motiveSources: { needVsWant: string } | null;
    };
    assert.equal(needed.decision?.action, "unlock");
    assert.equal(needed.decision?.signalEffect, "need_unlock");
    assert.equal(needed.motiveSources?.needVsWant, "keywords");

    const older = await post("/api/carts", {
      userId: "user-current",
      itemNames: ["iPhone 16 Pro"],
      totalCents: 119_900,
      parsed: true,
      demo: true,
    });
    await delay(5);
    const newer = await post("/api/carts", {
      userId: "user-current",
      itemNames: ["AirPods"],
      totalCents: 17_900,
      parsed: true,
      demo: true,
    });
    const listed = (await get("/api/carts?userId=user-current")) as { carts: CartBody[] };
    assert.equal(listed.carts.length, 1);
    assert.equal(listed.carts[0]?.code, (newer.body as CartBody).code);
    assert.notEqual(listed.carts[0]?.code, (older.body as CartBody).code);
    const gone = await fetch(`${base}/api/carts/${(older.body as CartBody).code}`);
    assert.equal(gone.status, 200);

    const reset = await post("/api/dev/reset", {});
    assert.equal(reset.status, 200);
    const afterReset = await fetch(`${base}/api/carts/${(newer.body as CartBody).code}`);
    assert.equal(afterReset.status, 404);
    const empty = (await get("/api/carts")) as { carts: CartBody[]; readError: string | null };
    assert.equal(empty.carts.length, 0);
    assert.equal(empty.readError, null);

    const fallback = await fetch(`${base}/fallback`);
    assert.equal(fallback.status, 200);
    const html = await fallback.text();
    assert.match(html, /Example phone/);
    assert.match(html, /Bag Subtotal/);
    assert.match(html, /\$1,200\.00/);
    assert.match(html, /Check Out/);
    assert.doesNotMatch(html, /Visa/);

    const amazon = await fetch(`${base}/amazon`);
    assert.equal(amazon.status, 200);
    const amazonHtml = await amazon.text();
    assert.match(amazonHtml, /Noise-cancelling headphones/);
    assert.match(amazonHtml, /Phone case/);
    assert.match(amazonHtml, /\$51\.98/);
    assert.match(amazonHtml, /Proceed to checkout/);
    assert.match(amazonHtml, /Buy Now/);
    assert.doesNotMatch(amazonHtml, /Visa/);
    assert.doesNotMatch(amazonHtml, /amazon\.com\/gp\/buy/);

    const carrier = await fetch(`${base}/carrier-switch`);
    assert.equal(carrier.status, 200);
    const carrierHtml = await carrier.text();
    assert.match(carrierHtml, /Example data/);
    assert.match(carrierHtml, /Switch to Carrier X/);
    assert.match(carrierHtml, /\$80\.00/);
    assert.match(carrierHtml, /\$74\.00/);
    assert.match(carrierHtml, /\$360\.00/);
    assert.match(carrierHtml, /\$120\.00/);
    assert.match(carrierHtml, />Switch</);
    const carrierPass = await fetch(`${base}/carrier-switch?case=pass`);
    assert.equal(carrierPass.status, 200);
    const passHtml = await carrierPass.text();
    assert.match(passHtml, /"balanceCents": 0/);
    assert.match(passHtml, /"feeCents": 0/);
    assert.doesNotMatch(passHtml, /https?:\/\//);
  });

  it("caps item names only after cleanup so a real title survives the screen-reader suffix", async () => {
    const real = "Noise-cancelling headphones ".repeat(5).trim();
    assert.ok(real.length <= 140);
    assert.ok(`${real} Opens in a new tab.`.length > 140);
    const kept = await post("/api/carts", {
      userId: "user-title-suffix",
      itemNames: [`  ${real}   Opens in a new tab.  `],
      totalCents: 1_999,
      parsed: true,
      demo: true,
    });
    assert.equal(kept.status, 201);
    assert.equal((kept.body as CartBody).items[0]?.name, real);

    const capped = await post("/api/carts", {
      userId: "user-title-cap",
      itemNames: ["B".repeat(180)],
      totalCents: 2_500,
      parsed: true,
      demo: true,
    });
    assert.equal(capped.status, 201);
    assert.equal((capped.body as CartBody).items[0]?.name, "B".repeat(140));
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
