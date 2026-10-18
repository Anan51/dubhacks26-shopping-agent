import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { boot, type BootHost } from "./content-boot.js";

(globalThis as { React?: typeof React }).React = React;

const CSS = readFileSync(new URL("./overlay.css", import.meta.url), "utf8");

const SHELL = `<!doctype html><html><head><title>Bag - Apple</title></head><body>
  <div id="page"><nav id="globalnav"></nav><div id="bag-container"></div><footer id="global-footersection"></footer></div>
  <button type="button" id="checkout" data-autom="bag-checkout-button"><span>Check Out</span></button>
</body></html>`;

const LATE_BAG = `<ol data-autom="bag-items"><li class="rs-bag-item rs-iteminfo-wrap" data-autom="bag-item-1" role="listitem"><h2 class="rs-iteminfo-title"><a data-autom="bag-item-name">USB-C Charge Cable</a></h2><select data-autom="item-quantity-dropdown"><option value="1" selected>1</option></select><div data-autom="Monthly_price"><p>$19.00</p></div></li></ol><div class="rs-summary-label" data-autom="bagtotalvalue">Total</div><div class="rs-summary-value" data-autom="bagtotalvalue">$19.00</div>`;

type Payload = { action?: string; method?: string; path?: string };

describe("bag card reliability", () => {
  it("mounts on a late bag and after pushState without a settings callback", async () => {
    const hung = open("https://www.apple.com/shop/bag", SHELL.replace("</body>", `${LATE_BAG}</body>`), {
      hangSettings: true,
    });
    try {
      await flush();
      assert.equal(hung.root()?.isConnected, true);
      assert.match(hung.text(), /USB-C Charge Cable/);
      assert.equal(hung.sent.some((message) => message.action === "settings"), true);
    } finally {
      hung.close();
    }

    const late = open("https://www.apple.com/shop/bag", SHELL, {});
    try {
      await flush();
      assert.equal(late.root(), null);
      late.document.querySelector("#bag-container")!.innerHTML = LATE_BAG;
      await wait(500);
      assert.equal(late.root()?.isConnected, true);
      assert.match(late.text(), /USB-C Charge Cable/);
      assert.equal(late.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
    } finally {
      late.close();
    }

    const routed = open("https://www.apple.com/shop/buy-iphone/iphone-17", SHELL, {});
    try {
      await flush();
      assert.equal(routed.root(), null);
      assert.equal(routed.document.querySelector("#checkout")?.hasAttribute("data-simmer-blocked"), false);
      routed.view.history.pushState({}, "", "/shop/bag");
      routed.document.querySelector("#bag-container")!.innerHTML = LATE_BAG;
      await wait(500);
      assert.equal(routed.root()?.isConnected, true);
      assert.match(routed.text(), /USB-C Charge Cable/);
      assert.equal(routed.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
    } finally {
      routed.close();
    }
  });

  it("shows Unlock once a reply allows it and keeps the card if the host is removed", async () => {
    const page = open("https://www.apple.com/shop/bag", SHELL.replace("</body>", `${LATE_BAG}</body>`), {
      cart: { replied: true, advice: "Wait on this one." },
    });
    try {
      await flush();
      const unlock = page.button("Unlock");
      assert.ok(unlock);
      assert.equal(page.root()?.style.getPropertyValue("z-index"), "2147483647");
      assert.equal(page.root()?.style.getPropertyPriority("z-index"), "important");
      const host = page.root();
      assert.ok(host);
      for (let turn = 0; turn < 25; turn += 1) {
        host.remove();
        const noise = page.document.createElement("div");
        noise.textContent = `render ${turn}`;
        page.document.querySelector("#bag-container")?.append(noise);
      }
      await flush();
      const again = page.button("Unlock");
      assert.equal(page.root()?.isConnected, true);
      assert.ok(again);
      again.click();
      await flush();
      assert.equal(page.sent.some((message) => message.path === "/api/carts/AB23CD/unlock"), true);
    } finally {
      page.close();
    }
  });

  it("does not unlock a low score and keeps a necessary bag open without Unlock", async () => {
    const low = open("https://www.apple.com/shop/bag", SHELL.replace("</body>", `${LATE_BAG}</body>`), {
      cart: { replied: false, purchaseScore: 1, scoreBucket: "strict" },
    });
    try {
      await flush();
      assert.equal(low.button("Unlock"), null);
      assert.equal(low.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
      assert.equal(low.sent.some((message) => message.path === "/api/carts/AB23CD/unlock"), false);
    } finally {
      low.close();
    }

    const necessary = open("https://www.apple.com/shop/bag", SHELL.replace("</body>", `${LATE_BAG}</body>`), {
      cart: { necessity: "necessary", isUnlocked: true, status: "unlocked", replied: false },
    });
    try {
      await flush();
      assert.equal(necessary.root()?.isConnected, true);
      assert.equal(necessary.button("Unlock"), null);
      assert.equal(necessary.document.querySelector("#checkout")?.hasAttribute("data-simmer-blocked"), false);
    } finally {
      necessary.close();
    }
  });

  it("applies settings and cart replies that arrive after the 2.5s fallback", async () => {
    const bag = SHELL.replace("</body>", `${LATE_BAG}</body>`);
    const optedOut = open("https://www.apple.com/shop/bag", bag, {
      replyDelayMs: 3000,
      optOut: ["apple.com"],
      cart: { necessity: "necessary", isUnlocked: true, status: "unlocked" },
    });
    try {
      await wait(2700);
      assert.equal(optedOut.root()?.isConnected, true);
      assert.equal(optedOut.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
      await wait(900);
      assert.equal(optedOut.root(), null);
      assert.equal(optedOut.document.querySelector("#checkout")?.hasAttribute("data-simmer-blocked"), false);
    } finally {
      optedOut.close();
    }

    const necessary = open("https://www.apple.com/shop/bag", bag, {
      replyDelayMs: 3000,
      cart: { necessity: "necessary", isUnlocked: true, status: "unlocked", replied: false },
    });
    try {
      await wait(2700);
      assert.equal(necessary.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
      await wait(3300);
      assert.equal(necessary.root()?.isConnected, true);
      assert.equal(necessary.document.querySelector("#checkout")?.hasAttribute("data-simmer-blocked"), false);
    } finally {
      necessary.close();
    }

    const locked = open("https://www.apple.com/shop/bag", bag, {
      replyDelayMs: 3000,
      cart: { necessity: "unnecessary", isUnlocked: false, status: "locked", replied: false },
    });
    try {
      await wait(6000);
      assert.equal(locked.root()?.isConnected, true);
      assert.equal(locked.button("Unlock"), null);
      assert.equal(locked.document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");
    } finally {
      locked.close();
    }
  });
});

function open(
  url: string,
  html: string,
  options: { hangSettings?: boolean; cart?: Record<string, unknown>; replyDelayMs?: number; optOut?: string[] },
) {
  const dom = new JSDOM(html, { url });
  const view = dom.window;
  view.setInterval = (() => 0) as typeof view.setInterval;
  const sent: Payload[] = [];
  const cart = {
    code: "AB23CD",
    status: "locked",
    isUnlocked: false,
    replied: false,
    totalCents: 1_900,
    parsedFromPage: true,
    items: [{ name: "USB-C Charge Cable" }],
    necessity: "unnecessary",
    lockEndsAt: new Date(Date.now() + 600_000).toISOString(),
    ...options.cart,
  };
  const globals = globalThis as { document?: Document; window?: Window };
  const previous = { document: globals.document, window: globals.window };
  globals.document = view.document;
  globals.window = view as unknown as Window;
  const runtime = {
    id: "simmer-test",
    sendMessage(message: unknown, callback?: (value: unknown) => void) {
      const payload = isPayload(message) ? message : {};
      sent.push(payload);
      const reply = () => {
        if (payload.action === "settings") {
          if (!options.hangSettings) {
            callback?.({
              origin: "http://127.0.0.1:4321",
              optOut: options.optOut ?? [],
              userId: "user-late-reply",
              cartCode: "",
            });
          }
          return;
        }
        if (payload.action === "remember-cart") {
          callback?.({ ok: true });
          return;
        }
        callback?.({ ok: true, body: cart });
      };
      if (options.replyDelayMs !== undefined && options.replyDelayMs > 0) {
        setTimeout(reply, options.replyDelayMs);
        return;
      }
      reply();
    },
  };
  const host: BootHost = {
    document: view.document,
    location: view.location,
    view: view as unknown as Window,
    runtime: () => runtime,
    css: CSS,
  };
  boot(host);
  return {
    document: view.document,
    view,
    sent,
    root: () => view.document.getElementById("simmer-root"),
    text: () => view.document.getElementById("simmer-root")?.shadowRoot?.textContent ?? "",
    button(label: string) {
      const buttons = view.document.getElementById("simmer-root")?.shadowRoot?.querySelectorAll("button");
      if (!buttons) {
        return null;
      }
      for (const button of buttons) {
        if (button.textContent?.trim() === label) {
          return button;
        }
      }
      return null;
    },
    close() {
      view.history.pushState({}, "", "/shop/buy-iphone/iphone-17");
      globals.document = previous.document;
      globals.window = previous.window;
    },
  };
}

function isPayload(value: unknown): value is Payload {
  return typeof value === "object" && value !== null;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
