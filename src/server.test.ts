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
  demo: boolean;
  coolingOffEndsAt: string;
  createdAt: string;
  smsLink: string | null;
  deskPath: string;
  synthetic: boolean;
  textMessage: string;
  decision: { action: string } | null;
  orderId: string | null;
  reminderAt: string | null;
  reminderFireAt: string | null;
};

type Transcript = { turns: { role: string; text: string }[] };

describe("checkout demo", () => {
  let base = "";
  let running: RunningApp;
  let close: () => Promise<void>;

  before(async () => {
    running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      coolingMs: 600_000,
      demoReminderMs: 80,
      demoDefault: false,
      agentHandle: "+15550001111",
      photon: null,
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

  it("runs a wait, a one-minute reminder, and a confirmed buy", async () => {
    const catalog = (await get("/api/catalog")) as { synthetic: boolean; products: { id: string }[] };
    assert.equal(catalog.synthetic, true);
    assert.ok(catalog.products.some((product) => product.id === "phone-n1-128"));

    const config = (await get("/api/config")) as { channel: string; agentHandle: string };
    assert.equal(config.channel, "stub");
    assert.equal(config.agentHandle, "+15550001111");

    const missingPhone = await post("/api/carts", { itemIds: ["acc-case"], demo: true });
    assert.equal(missingPhone.status, 400);

    const created = await post("/api/carts", {
      itemIds: ["phone-n1-128", "plan-unlimited", "acc-case"],
      demo: true,
    });
    assert.equal(created.status, 201);
    const cart = created.body as CartBody;
    assert.equal(cart.synthetic, true);
    assert.equal(cart.status, "cooling");
    assert.equal(cart.demo, true);
    assert.equal(new Date(cart.coolingOffEndsAt).getTime() - new Date(cart.createdAt).getTime(), 600_000);
    assert.equal(cart.smsLink, `sms:+15550001111&body=${encodeURIComponent(cart.textMessage)}`);
    assert.equal(cart.deskPath, `/dev?cart=${cart.code}`);

    const waitLines = [`Hey WaitMate, cart ${cart.code}`, "14 months", "it works fine", "420", "1500"];
    let transcript: Transcript = { turns: [] };
    for (const line of waitLines) {
      const sent = await post("/api/dev/messages", { conversationId: "desk:wait-demo-1", text: line });
      assert.equal(sent.status, 200);
      transcript = sent.body as Transcript;
    }
    assert.match(transcript.turns.at(-1)?.text ?? "", /Wait/);

    const saved = (await get(`/api/carts/${cart.code}`)) as CartBody;
    assert.equal(saved.status, "saved");
    assert.equal(saved.decision?.action, "wait");
    assert.ok(saved.reminderAt);
    assert.ok(saved.reminderFireAt);

    let reminded = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(50);
      const follow = (await get("/api/dev/messages?conversationId=desk:wait-demo-1")) as Transcript;
      if (follow.turns.some((turn) => turn.text.includes(`/c/${cart.code}`))) {
        reminded = true;
        break;
      }
    }
    assert.equal(reminded, true);

    const buy = await post("/api/carts", {
      itemIds: ["phone-harbor-fold", "plan-prepaid"],
      demo: false,
    });
    const buyCart = buy.body as CartBody;
    const buyLines = [
      `Hey WaitMate, cart ${buyCart.code}`,
      "38 months",
      "screen is cracked and the battery dies by 3pm",
      "0",
      "2000",
      "YES",
    ];
    for (const line of buyLines) {
      const sent = await post("/api/dev/messages", { conversationId: "desk:buy-demo-01", text: line });
      assert.equal(sent.status, 200);
    }
    const done = (await get(`/api/carts/${buyCart.code}`)) as CartBody;
    assert.equal(done.status, "completed");
    assert.equal(done.orderId, `WM-${buyCart.code.slice(0, 4)}`);
  });

  async function get(pathname: string): Promise<unknown> {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.ok, true);
    return response.json() as Promise<unknown>;
  }

  async function post(pathname: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }
});
