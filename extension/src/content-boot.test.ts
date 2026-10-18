import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { boot, type BootHost } from "./content-boot.js";

(globalThis as { React?: typeof React }).React = React;

const AMAZON_HTML = readFileSync(new URL("../../web/amazon-cart.html", import.meta.url), "utf8");
const APPLE_HTML = readFileSync(new URL("../../web/fallback.html", import.meta.url), "utf8");
const CSS = readFileSync(new URL("./overlay.css", import.meta.url), "utf8");

const BOOTS: { name: string; url: string; html: string; blocked: string }[] = [
  { name: "amazon cart", url: "https://www.amazon.com/gp/cart", html: AMAZON_HTML, blocked: "#proceed" },
  { name: "amazon checkout", url: "https://www.amazon.com/checkout", html: AMAZON_HTML, blocked: "#proceed" },
  { name: "amazon buy", url: "https://www.amazon.com/gp/buy", html: AMAZON_HTML, blocked: "#proceed" },
  { name: "local amazon fixture", url: "http://127.0.0.1:4321/amazon", html: AMAZON_HTML, blocked: "#proceed" },
  { name: "uk bag", url: "https://www.apple.com/uk/shop/bag", html: APPLE_HTML, blocked: "#checkout" },
  { name: "bag trailing slash", url: "https://www.apple.com/shop/bag/", html: APPLE_HTML, blocked: "#checkout" },
  { name: "bag query", url: "https://www.apple.com/shop/bag?ref=nav", html: APPLE_HTML, blocked: "#checkout" },
  { name: "secure checkout", url: "https://secure6.store.apple.com/shop/checkout", html: APPLE_HTML, blocked: "#checkout" },
  { name: "fallback fixture", url: "http://127.0.0.1:4321/fallback", html: APPLE_HTML, blocked: "#checkout" },
];

const IDLE = [
  "https://www.apple.com/shop/buy-iphone/iphone-17",
  "https://www.apple.com/shop/product/mw2l3am/a/usb-c-charge-cable",
  "https://www.apple.com/shop/bags",
  "https://www.apple.com/amazon",
];

describe("content boot", () => {
  for (const row of BOOTS) {
    it(`starts the gate, card, and observer on ${row.name}`, async () => {
      const started = bootAt(row.url, row.html);
      await flush();
      assert.ok(started.document.querySelector("#simmer-root"), "card");
      const blocked = started.document.querySelector(row.blocked);
      assert.equal(blocked?.getAttribute("data-simmer-blocked"), "1", "gate");

      const added =
        row.blocked === "#proceed"
          ? Object.assign(started.document.createElement("input"), {
              type: "button",
              name: "proceedToRetailCheckout",
              value: "Proceed to checkout",
            })
          : Object.assign(started.document.createElement("button"), { type: "button", textContent: "Check Out" });
      started.document.body.append(added);
      await flush();
      assert.equal(added.getAttribute("data-simmer-blocked"), "1", "observer");
    });
  }

  for (const url of IDLE) {
    it(`stays idle on ${url}`, async () => {
      const html = `<!doctype html><body><button type="button" id="checkout">Check Out</button></body>`;
      const started = bootAt(url, html);
      await flush();
      assert.equal(started.document.querySelector("#simmer-root"), null, url);
      assert.equal(started.document.querySelector("#checkout")?.hasAttribute("data-simmer-blocked"), false, url);
      const added = started.document.createElement("button");
      added.type = "button";
      added.textContent = "Check Out";
      started.document.body.append(added);
      await flush();
      assert.equal(added.hasAttribute("data-simmer-blocked"), false, url);
      assert.equal(started.document.querySelector("#simmer-root"), null, url);
    });
  }
});

function bootAt(url: string, html: string): { document: Document } {
  const dom = new JSDOM(html, { url });
  const view = dom.window;
  view.setInterval = (() => 0) as typeof view.setInterval;
  view.setTimeout = (() => 0) as typeof view.setTimeout;
  const pageWindow = view as unknown as Window;
  const globals = globalThis as { document?: Document; window?: Window };
  globals.document = view.document;
  globals.window = pageWindow;
  const runtime = {
    id: "simmer-test",
    sendMessage(message: unknown, callback?: (value: unknown) => void) {
      const payload = message as { action?: string; method?: string; path?: string };
      if (payload.action === "settings") {
        callback?.({ origin: "http://127.0.0.1:4321", optOut: [], userId: "user-local", cartCode: "" });
        return;
      }
      if (payload.action === "remember-cart") {
        callback?.({ ok: true });
        return;
      }
      if (payload.action === "api" && payload.method === "POST" && payload.path === "/api/carts") {
        callback?.({
          ok: true,
          body: {
            code: "BAG123",
            status: "locked",
            isUnlocked: false,
            totalCents: 5198,
            parsedFromPage: true,
            items: [{ name: "Noise-cancelling headphones" }],
          },
        });
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
  return { document: view.document };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
