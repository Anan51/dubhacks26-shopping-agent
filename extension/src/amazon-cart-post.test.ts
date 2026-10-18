import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { BAG_READ_DEBOUNCE_MS, bagContentKey, bagReadAction, type PageBag } from "./bag-dom.js";
import { boot, type BootHost } from "./content-boot.js";

(globalThis as { React?: typeof React }).React = React;

const CSS = readFileSync(new URL("./overlay.css", import.meta.url), "utf8");
const FULL = "Anker USB-C to USB-C Cable (10 ft), 100W Fast Charging Braided Cord";

describe("cart post identity", () => {
  it("reuses the pending code when normalized items, quantity, and cents are unchanged", () => {
    const posted = pageBag(
      [
        { name: FULL, quantity: 1 },
        { name: "Phone case", quantity: 1 },
      ],
      1_299,
    );
    const key = bagContentKey(posted);
    assert.equal(key, `1|1299|${FULL}\n1|Phone case`);

    const rewritten = pageBag(
      [
        { name: `  ${FULL}   Opens in a new tab.  `, quantity: 1 },
        { name: "Phone   case", quantity: 1 },
      ],
      1_299,
    );
    assert.equal(bagContentKey(rewritten), key);
    assert.equal(bagReadAction(key, rewritten), "keep");

    const more = pageBag(
      [
        { name: FULL, quantity: 2 },
        { name: "Phone case", quantity: 1 },
      ],
      2_298,
    );
    assert.equal(bagReadAction(key, more), "post");
    assert.notEqual(bagContentKey(more), key);
  });

  it("posts once for two reads of the same bag inside the debounce window and keeps that code", async () => {
    const posts: { itemNames: string[]; totalCents: number }[] = [];
    const timers: { id: number; ms: number; run: () => void }[] = [];
    let nextTimer = 1;
    const dom = new JSDOM(cartHtml(), { url: "https://www.amazon.com/gp/cart/view.html" });
    const view = dom.window;
    const previous = {
      document: (globalThis as { document?: Document }).document,
      window: (globalThis as { window?: Window }).window,
    };
    (globalThis as { document?: Document }).document = view.document;
    (globalThis as { window?: Window }).window = view as unknown as Window;
    view.setInterval = (() => 0) as typeof view.setInterval;
    view.clearInterval = (() => undefined) as typeof view.clearInterval;
    view.setTimeout = ((run: () => void, ms?: number) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.push({ id, ms: ms ?? 0, run });
      return id;
    }) as typeof view.setTimeout;
    view.clearTimeout = ((id?: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    }) as typeof view.clearTimeout;

    const runtime = {
      id: "simmer-test",
      sendMessage(message: unknown, callback?: (value: unknown) => void) {
        const payload = message as {
          action?: string;
          method?: string;
          path?: string;
          body?: { itemNames?: string[]; totalCents?: number };
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
          const code = posts.length === 1 ? "2F8W6M" : "2MHG76";
          callback?.({
            ok: true,
            body: {
              code,
              status: "locked",
              isUnlocked: false,
              totalCents,
              parsedFromPage: true,
              linkMessage: code,
              items: itemNames.map((name) => ({ name })),
            },
          });
          return;
        }
        callback?.({ ok: true, body: null });
      },
    };

    try {
      const host: BootHost = {
        document: view.document,
        location: view.location,
        view: view as unknown as Window,
        runtime: () => runtime,
        css: CSS,
      };
      boot(host);
      await flushSoon(timers);

      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0], { itemNames: [FULL], totalCents: 99 });
      assert.equal(cardText(view.document).includes("2F8W6M"), true);
      assert.equal(cardText(view.document).includes("2MHG76"), false);
      assert.equal(countTitle(cardText(view.document)), 1);
      assert.equal(cardText(view.document).includes("Opens in a new tab"), false);
      assert.equal(pending(timers, BAG_READ_DEBOUNCE_MS), 0);

      const cut = view.document.querySelector(".a-truncate-cut");
      const offscreen = view.document.querySelector(".sc-product-title > .a-offscreen:not(.a-truncate-full)");
      assert.ok(cut);
      assert.ok(offscreen);
      cut.textContent = `${FULL} `;
      await flushSoon(timers);
      offscreen.textContent = "Opens in a new tab. Again.";
      await flushSoon(timers);
      assert.equal(posts.length, 1);
      assert.equal(pending(timers, BAG_READ_DEBOUNCE_MS), 1);

      runTimers(timers, BAG_READ_DEBOUNCE_MS);
      await flushSoon(timers);
      assert.equal(posts.length, 1);
      assert.equal(cardText(view.document).includes("2F8W6M"), true);
      assert.equal(cardText(view.document).includes("2MHG76"), false);

      const select = view.document.querySelector("select[name='quantity']");
      const subtotal = view.document.querySelector("#sc-subtotal-amount-activecart .a-offscreen");
      assert.equal(select?.tagName, "SELECT");
      assert.ok(select);
      assert.ok(subtotal);
      (select as HTMLSelectElement).value = "2";
      subtotal.textContent = "$1.98";
      await flushSoon(timers);
      assert.equal(pending(timers, BAG_READ_DEBOUNCE_MS), 1);
      runTimers(timers, BAG_READ_DEBOUNCE_MS);
      await flushSoon(timers);

      assert.equal(posts.length, 2);
      assert.deepEqual(posts[1], { itemNames: [FULL], totalCents: 198 });
      assert.equal(cardText(view.document).includes("2MHG76"), true);
      assert.equal(cardText(view.document).includes("2F8W6M"), false);
    } finally {
      for (const timer of [...timers]) {
        timer.run = () => undefined;
      }
      timers.splice(0, timers.length);
      (globalThis as { document?: Document }).document = previous.document;
      (globalThis as { window?: Window }).window = previous.window;
      view.close();
    }
  });
});

function pageBag(items: { name: string; quantity: number }[], totalCents: number): PageBag {
  return {
    items: items.map((item, index) => ({
      position: index + 1,
      name: item.name,
      quantity: item.quantity,
      linePriceCents: totalCents,
    })),
    itemNames: items.map((item) => item.name),
    quantity: items[0]?.quantity ?? null,
    subtotalCents: totalCents,
    totalCents,
    parsed: true,
  };
}

function cartHtml(): string {
  return `<!doctype html><body>
    <div id="sc-active-cart">
      <div data-asin="B0TITLE" class="sc-list-item">
        <span class="a-truncate sc-product-title" data-a-word-break="normal">
          <span class="a-truncate-full a-offscreen">${FULL}</span>
          <span class="a-truncate-cut" aria-hidden="true">${FULL}</span>
          <span class="a-offscreen">Opens in a new tab.</span>
        </span>
        <span class="a-price"><span class="a-offscreen">$0.99</span></span>
        <select name="quantity"><option value="1" selected>1</option><option value="2">2</option></select>
      </div>
      <span id="sc-subtotal-amount-activecart"><span class="a-offscreen">$0.99</span></span>
    </div>
    <input name="proceedToRetailCheckout" type="button" value="Proceed to checkout" />
  </body>`;
}

function cardText(document: Document): string {
  const root = document.querySelector("#simmer-root");
  return root?.shadowRoot?.textContent ?? "";
}

function countTitle(text: string): number {
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const found = text.indexOf(FULL, from);
    if (found < 0) {
      return count;
    }
    count += 1;
    from = found + FULL.length;
  }
  return count;
}

function pending(timers: { ms: number }[], ms: number): number {
  return timers.filter((timer) => timer.ms === ms).length;
}

function runTimers(timers: { id: number; ms: number; run: () => void }[], ms: number): void {
  const due = timers.filter((timer) => timer.ms === ms);
  for (const timer of due) {
    const index = timers.indexOf(timer);
    if (index >= 0) {
      timers.splice(index, 1);
    }
  }
  for (const timer of due) {
    timer.run();
  }
}

async function flushSoon(timers: { id: number; ms: number; run: () => void }[]): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    runTimers(timers, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
