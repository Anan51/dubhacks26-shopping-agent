import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

// Brings the Express Request.user augmentation into this project's typecheck.
import "../../src/auth/session.js";
import { createApp } from "../../src/app.js";
import { createMemoryStore } from "../../src/store.js";
import { boot, type BootHost } from "./content-boot.js";
import { mountOverlay, type OverlayModel } from "./overlay.js";

(globalThis as { React?: typeof React }).React = React;

const CSS = readFileSync(new URL("./overlay.css", import.meta.url), "utf8");
const AMAZON_FIXTURE = readFileSync(new URL("../../web/amazon-cart.html", import.meta.url), "utf8");
const APPLE_FIXTURE = readFileSync(new URL("../../web/fallback.html", import.meta.url), "utf8");

type PostedBag = { itemNames: string[]; totalCents: number };

describe("cart card items", { concurrency: false }, () => {
  it("shows both names and total quantity 2 for a two-item Amazon cart", async () => {
    const booted = bootCart(
      "https://www.amazon.com/gp/cart/view.html",
      cartHtml([
        line("B010", "Notebook <span class=\"a-offscreen\">Opens in a new tab.</span>", "$0.99", "<select name=\"quantity\"><option value=\"1\" selected>1</option></select>"),
        line("B011", "Pencil", "$0.89", "<span class=\"a-dropdown-prompt\">Qty: 1</span>"),
      ], "$1.88"),
    );
    await flush();
    try {
      assert.equal(booted.posts.length, 1);
      assert.deepEqual(booted.posts[0], { itemNames: ["Notebook", "Pencil"], totalCents: 188 });
      assert.equal(Number.isInteger(booted.posts[0]?.totalCents), true);
      const text = cardText(booted.document);
      assert.equal(text.includes("Notebook"), true);
      assert.equal(text.includes("Pencil"), true);
      assert.equal(text.includes("Opens in a new tab"), false);
      assert.equal(text.includes("2 items · $1.88"), true);
      assert.equal(text.includes("1 item"), false);
    } finally {
      booted.close();
    }
  });

  it("shows quantity 3 for a single Amazon line", async () => {
    const booted = bootCart(
      "https://www.amazon.com/gp/cart/view.html",
      cartHtml(
        [line("B012", "USB-C Cable", "$1.00", "<select name=\"quantity\"><option value=\"3\" selected>3</option></select>")],
        "$3.00",
      ),
    );
    await flush();
    try {
      assert.deepEqual(booted.posts[0], { itemNames: ["USB-C Cable"], totalCents: 300 });
      assert.equal(Number.isInteger(booted.posts[0]?.totalCents), true);
      const text = cardText(booted.document);
      assert.equal(text.includes("USB-C Cable"), true);
      assert.equal(text.includes("3 items · $3"), true);
      assert.equal(text.includes("1 item"), false);
    } finally {
      booted.close();
    }
  });

  it("shows both fixture items and the summed quantity", async () => {
    const booted = bootCart("http://127.0.0.1:4321/amazon", AMAZON_FIXTURE);
    await flush();
    try {
      assert.deepEqual(booted.posts[0]?.itemNames, ["Noise-cancelling headphones", "Phone case"]);
      assert.equal(booted.posts[0]?.totalCents, 5198);
      assert.equal(Number.isInteger(booted.posts[0]?.totalCents), true);
      const text = cardText(booted.document);
      assert.equal(text.includes("Noise-cancelling headphones"), true);
      assert.equal(text.includes("Phone case"), true);
      assert.equal(text.includes("3 items · $51.98"), true);
      assert.equal(booted.document.querySelector("#proceed")?.getAttribute("data-simmer-blocked"), "1");
      assert.equal(booted.document.querySelector("#buy-now")?.getAttribute("data-simmer-blocked"), "1");
      assert.equal(booted.document.querySelector("#remove")?.hasAttribute("data-simmer-blocked"), false);
      assert.equal(booted.document.querySelector("#nav-proceed")?.hasAttribute("data-simmer-blocked"), false);
      assert.equal(booted.document.querySelector("#footer-buy")?.hasAttribute("data-simmer-blocked"), false);
    } finally {
      booted.close();
    }
  });

  it("leaves the Apple bag on one product name and the same checkout gate", async () => {
    const booted = bootCart("http://127.0.0.1:4321/fallback", APPLE_FIXTURE);
    await flush();
    try {
      assert.deepEqual(booted.posts[0]?.itemNames, ["Example phone"]);
      assert.equal(booted.posts[0]?.totalCents, 120_000);
      const text = cardText(booted.document);
      assert.equal(text.includes("Example phone · $1,200"), true);
      assert.equal(text.includes("Phone case"), false);
      assert.equal(text.includes("1 item"), false);
      assert.equal(booted.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
      assert.equal(booted.document.querySelector("#apple-pay")?.getAttribute("data-simmer-blocked"), "1");
      assert.equal(booted.document.querySelector("#remove")?.hasAttribute("data-simmer-blocked"), false);
      assert.equal(booted.document.querySelector("#continue")?.hasAttribute("data-simmer-blocked"), false);
      assert.equal(booted.document.querySelector("#foot-pay")?.hasAttribute("data-simmer-blocked"), false);
    } finally {
      booted.close();
    }
  });

  it("keeps a one-line Apple bag at that line's quantity", async () => {
    const booted = bootCart(
      "https://www.apple.com/shop/bag",
      `<!doctype html><body>
        <button type="button" id="checkout" data-autom="checkout"><span>Check Out</span></button>
        <button type="button" id="apple-pay" data-autom="checkout-with-apple-pay"><span>Apple Pay</span></button>
        <button type="button" id="remove">Remove</button>
        <ul><li class="rs-bag-item" data-autom="bag-item-1">
          <a data-autom="bag-item-name">60W USB-C Charge Cable (1 m)</a>
          <select data-autom="item-quantity-dropdown"><option value="1" selected>1</option></select>
          <div data-autom="Monthly_price"><p>$19.00</p></div>
        </li></ul>
        <div data-autom="bagtotalvalue">$21.00</div>
      </body>`,
    );
    await flush();
    try {
      assert.deepEqual(booted.posts[0]?.itemNames, ["60W USB-C Charge Cable (1 m)"]);
      assert.equal(booted.posts[0]?.totalCents, 2100);
      const text = cardText(booted.document);
      assert.equal(text.includes("60W USB-C Charge Cable (1 m)"), true);
      assert.equal(text.includes("1 item · $21"), true);
      assert.equal(text.includes("Phone case"), false);
      assert.equal(booted.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
      assert.equal(booted.document.querySelector("#apple-pay")?.getAttribute("data-simmer-blocked"), "1");
      assert.equal(booted.document.querySelector("#remove")?.hasAttribute("data-simmer-blocked"), false);
    } finally {
      booted.close();
    }
  });

  it("lists the first five titles and a more count when the cart has more", async () => {
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
    const booted = renderCard({
      itemNames: names,
      quantity: names.length,
      totalCents: 600,
    });
    await flush();
    try {
      const text = booted.text();
      for (const name of names.slice(0, 5)) {
        assert.equal(text.includes(name), true, name);
      }
      assert.equal(text.includes("Foxtrot"), false);
      assert.equal(text.includes("+1 more"), true);
      assert.equal(text.includes("6 items · $6"), true);
    } finally {
      booted.close();
    }
  });

  it("rebuilds +k more from the saved cart after the real post", async () => {
    const running = createApp({
      store: createMemoryStore(),
      origin: "http://127.0.0.1",
      lockMs: 600_000,
      demoReminderMs: 60_000,
      demoDefault: false,
      agentHandle: null,
      photon: null,
      xaiModel: "grok-test",
      xaiTimeoutMs: 1_000,
      polish: async (template) => template,
      backboardEnabled: false,
    });
    const server = createServer(running.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await assertSavedBag(base, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"], 0);
      await assertSavedBag(base, ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"], 1);
      await assertSavedBag(base, ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"], 2);
    } finally {
      running.scheduler.stop();
      running.stopCheckIns();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function line(asin: string, title: string, price: string, quantity: string): string {
  return `<div data-asin="${asin}" class="sc-list-item">
    <span class="sc-product-title">${title}</span>
    <span class="a-price"><span class="a-offscreen">${price}</span></span>
    ${quantity}
  </div>`;
}

function cartHtml(rows: string[], subtotal: string): string {
  return `<!doctype html><body>
    <div id="sc-active-cart">
      ${rows.join("")}
      <span id="sc-subtotal-amount-activecart"><span class="a-offscreen">${subtotal}</span></span>
    </div>
    <input name="proceedToRetailCheckout" type="button" value="Proceed to checkout" />
  </body>`;
}

type CartPostBody = { itemNames?: string[]; totalCents?: number; hiddenItemCount?: number };

async function assertSavedBag(base: string, names: string[], hidden: number): Promise<void> {
  const dollars = names.length.toFixed(2);
  let saved: Record<string, unknown> | null = null;
  const booted = bootCart(
    "https://www.amazon.com/gp/cart/view.html",
    cartHtml(
      names.map((name, index) =>
        line(
          `B${index}`,
          name,
          "$1.00",
          `<select name="quantity"><option value="1" selected>1</option></select>`,
        ),
      ),
      `$${dollars}`,
    ),
    async (body) => {
      const response = await fetch(`${base}/api/carts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`cart post failed: ${response.status}`);
      }
      saved = parsed;
      return parsed;
    },
  );
  try {
    await Promise.race([
      booted.saved,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("saved cart did not rebuild")), 5_000);
      }),
    ]);
    await flush();
    const cart = saved as Record<string, unknown> | null;
    const items = Array.isArray(cart?.items) ? cart.items : [];
    const itemNames = items.flatMap((item) =>
      item && typeof item === "object" && "name" in item && typeof item.name === "string" ? [item.name] : [],
    );
    assert.deepEqual(itemNames, names.slice(0, 5));
    assert.equal(cart?.hiddenItemCount, hidden > 0 ? hidden : undefined);
    const text = cardText(booted.document);
    for (const name of names.slice(0, 5)) {
      assert.equal(text.includes(name), true, name);
    }
    for (const name of names.slice(5)) {
      assert.equal(text.includes(name), false, name);
    }
    if (hidden > 0) {
      assert.equal(text.includes(`+${hidden} more`), true);
    } else {
      assert.equal(text.includes(" more"), false);
    }
    assert.equal(text.includes(`${names.length} items · $${names.length}`), true);
    assert.equal(booted.document.querySelector("input[name='proceedToRetailCheckout']")?.getAttribute("data-simmer-blocked"), "1");
  } finally {
    booted.close();
  }
}

function bootCart(
  url: string,
  html: string,
  save?: (body: CartPostBody) => Promise<Record<string, unknown>>,
): { document: Document; posts: PostedBag[]; saved: Promise<void>; close: () => void } {
  const dom = new JSDOM(html, { url });
  const view = dom.window;
  const previous = {
    document: (globalThis as { document?: Document }).document,
    window: (globalThis as { window?: Window }).window,
  };
  const posts: PostedBag[] = [];
  let markSaved: () => void = () => undefined;
  let failSaved: (error: unknown) => void = () => undefined;
  const saved = new Promise<void>((resolve, reject) => {
    markSaved = resolve;
    failSaved = reject;
  });
  view.setInterval = (() => 0) as typeof view.setInterval;
  view.setTimeout = (() => 0) as typeof view.setTimeout;
  const pageWindow = view as unknown as Window;
  (globalThis as { document?: Document }).document = view.document;
  (globalThis as { window?: Window }).window = pageWindow;
  const runtime = {
    id: "simmer-test",
    sendMessage(message: unknown, callback?: (value: unknown) => void) {
      const payload = message as {
        action?: string;
        method?: string;
        path?: string;
        body?: CartPostBody;
      };
      if (payload.action === "settings") {
        callback?.({ origin: "http://127.0.0.1:4321", optOut: [], userId: "user-local", cartCode: "" });
        return;
      }
      if (payload.action === "remember-cart") {
        callback?.({ ok: true });
        return;
      }
      if (payload.action === "api" && payload.method === "POST" && payload.path === "/api/carts") {
        const itemNames = payload.body?.itemNames ?? [];
        const totalCents = payload.body?.totalCents ?? 0;
        posts.push({ itemNames, totalCents });
        if (save) {
          void save(payload.body ?? {})
            .then((body) => {
              callback?.({ ok: true, body });
              markSaved();
            })
            .catch((error: unknown) => {
              callback?.({ ok: false, body: null });
              failSaved(error);
            });
          return;
        }
        callback?.({
          ok: true,
          body: {
            code: "BAG123",
            status: "locked",
            isUnlocked: false,
            totalCents,
            parsedFromPage: true,
            items: itemNames.map((name) => ({ name })),
          },
        });
        markSaved();
        return;
      }
      callback?.({ ok: true, body: null });
    },
  };
  const host: BootHost = {
    document: view.document,
    location: view.location,
    view: pageWindow,
    runtime: () => runtime,
    css: CSS,
  };
  boot(host);
  return {
    document: view.document,
    posts,
    saved,
    close() {
      (globalThis as { document?: Document }).document = previous.document;
      (globalThis as { window?: Window }).window = previous.window;
    },
  };
}

function renderCard(overrides: Partial<OverlayModel>): { text: () => string; close: () => void } {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://www.amazon.com/gp/cart/view.html" });
  const view = dom.window;
  const previous = {
    document: (globalThis as { document?: Document }).document,
    window: (globalThis as { window?: Window }).window,
  };
  view.setInterval = (() => 0) as typeof view.setInterval;
  (globalThis as { document?: Document }).document = view.document;
  (globalThis as { window?: Window }).window = view as unknown as Window;
  const host = view.document.createElement("div");
  view.document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  mountOverlay(shadow, cardModel(overrides), { unlock() {}, sleep() {} });
  return {
    text: () => shadow.textContent ?? "",
    close() {
      (globalThis as { document?: Document }).document = previous.document;
      (globalThis as { window?: Window }).window = previous.window;
    },
  };
}

function cardModel(overrides: Partial<OverlayModel>): OverlayModel {
  return {
    code: "BAG123",
    status: "locked",
    isUnlocked: false,
    lockEndsAt: new Date(Date.now() + 60_000).toISOString(),
    vaultUntil: null,
    totalCents: 0,
    parsedFromPage: true,
    itemNames: [],
    quantity: null,
    explanation: null,
    decision: null,
    signals: {},
    motiveSources: null,
    reading: false,
    userId: "user-local",
    linkMessage: null,
    fallbackPage: false,
    replied: false,
    advice: null,
    pingDelivered: true,
    pingReason: null,
    smsLink: null,
    qrDataUrl: null,
    turns: [],
    error: null,
    necessity: "unnecessary",
    necessitySource: null,
    necessityReason: null,
    userImpulseScore: null,
    justificationGrade: null,
    gradeSource: null,
    gradeReason: null,
    purchaseScore: null,
    scoreBucket: "strict",
    scoreReason: null,
    ...overrides,
  };
}

function cardText(document: Document): string {
  return document.querySelector("#simmer-root")?.shadowRoot?.textContent ?? "";
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
