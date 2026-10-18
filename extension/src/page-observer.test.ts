import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { readPageBag } from "./bag-dom.js";
import { installGate } from "./gate.js";
import { watchPage } from "./page-observer.js";
import { amazonAdapter } from "./stores/amazon.js";
import { appleAdapter } from "./stores/apple.js";

const FALLBACK_HTML = new URL("../../web/fallback.html", import.meta.url);

function iphoneDocument(): Document {
  return new JSDOM(`<!doctype html><html><head><title>Bag - Apple</title></head><body>
    <p id="unrelated">Store</p>
    <div id="bag-column">
      <ul>
        <li class="rs-bag-item" data-autom="bag-item-1">
          <h2 class="rs-iteminfo-title"><a data-autom="bag-item-name">iPhone 17 256GB</a></h2>
          <select data-autom="item-quantity-dropdown"><option value="1" selected>1</option></select>
          <div data-autom="Monthly_price"><p>$1,027.01</p></div>
          <button type="button" id="checkout">Check Out</button>
          <button type="button" id="apple-pay">Apple Pay</button>
        </li>
      </ul>
      <div data-autom="bagtotalvalue">$1,027.01</div>
    </div>
  </body></html>`).window.document;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("locked bag observer", () => {
  it("paints a lockable bag a bounded number of times, then restores the buttons on unlock", async () => {
    const document = iphoneDocument();
    const view = document.defaultView;
    assert.ok(view);
    assert.equal(typeof view.MutationObserver, "function");
    const checkout = document.querySelector("#checkout");
    const applePay = document.querySelector("#apple-pay");
    assert.ok(checkout instanceof view.HTMLButtonElement);
    assert.ok(applePay instanceof view.HTMLButtonElement);
    const bag = readPageBag(document);
    assert.equal(bag.parsed, true);
    assert.deepEqual(bag.itemNames, ["iPhone 17 256GB"]);
    assert.equal(bag.totalCents, 102_701);

    let paints = 0;
    let showBlock = true;
    const gate = installGate(document, () => [checkout, applePay]);
    const watch = watchPage(document, () => {
      if (!showBlock) {
        return;
      }
      paint();
    });

    const paint = () => {
      paints += 1;
      if (paints > 6) {
        watch.disconnect();
        return;
      }
      gate.paint();
    };

    paint();
    await flush();
    assert.ok(paints <= 3, `paints after load: ${paints}`);
    assert.equal(checkout.getAttribute("data-simmer-blocked"), "1");
    assert.equal(applePay.getAttribute("data-simmer-blocked"), "1");
    assert.equal(checkout.nextElementSibling?.getAttribute("data-simmer-badge"), "1");
    assert.equal(checkout.disabled, true);

    const afterLoad = paints;
    const unrelated = document.querySelector("#unrelated");
    assert.ok(unrelated);
    unrelated.textContent = "Hours";
    await flush();
    assert.ok(paints - afterLoad <= 3, `paints after an unrelated change: ${paints - afterLoad}`);

    showBlock = false;
    gate.lift();
    await flush();
    for (const button of [checkout, applePay]) {
      assert.equal(button.disabled, false);
      assert.equal(button.hasAttribute("data-simmer-blocked"), false);
      assert.equal(button.hasAttribute("data-simmer-disabled"), false);
      assert.equal(button.hasAttribute("aria-disabled"), false);
      assert.equal(button.textContent === "Check Out" || button.textContent === "Apple Pay", true);
    }
    assert.equal(document.querySelector("[data-simmer-badge]"), null);
    assert.equal(document.querySelector("[data-simmer-blocked]"), null);

    watch.disconnect();
  });

  it("does not repaint itself while Apple edits text and inserts nodes", async () => {
    const html = readFileSync(FALLBACK_HTML, "utf8");
    const document = new JSDOM(html, { url: "https://www.apple.com/shop/bag" }).window.document;
    const checkout = document.querySelector("#checkout");
    const applePay = document.querySelector("#apple-pay");
    const nav = document.querySelector("#nav-store");
    const label = checkout?.querySelector("span");
    const shell = document.querySelector("#page");
    const view = document.defaultView;
    assert.ok(view);
    assert.ok(checkout instanceof view.HTMLButtonElement);
    assert.ok(applePay);
    assert.ok(nav);
    assert.ok(label);
    assert.ok(shell);

    let paints = 0;
    const gate = installGate(document, () => appleAdapter.checkoutButtons(document));
    const watch = watchPage(document, () => {
      paints += 1;
      if (paints > 8) {
        watch.disconnect();
        return;
      }
      watch.mute(() => gate.paint());
    });
    watch.mute(() => gate.paint());
    await flush();
    assert.equal(paints, 0, "painting the block scheduled another pass");
    assert.equal(checkout.getAttribute("data-simmer-blocked"), "1");
    assert.equal(nav.hasAttribute("data-simmer-blocked"), false);

    const noise = document.createElement("p");
    noise.id = "live-copy";
    noise.textContent = "Store hours";
    nav.parentElement?.append(noise);
    for (let tick = 0; tick < 20; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      // characterData. The previous storm set the same string twice, so it never
      // notified, and class/attribute edits are not what the old observer watched.
      noise.textContent = `Store hours ${tick}`;
      label.textContent = tick % 2 === 0 ? "Check Out" : "Check Out ";
      const extra = document.createElement("span");
      extra.className = "apple-live";
      extra.textContent = `tick ${tick}`;
      shell.append(extra);
      extra.remove();
    }
    await flush();
    assert.ok(paints <= 3, `paints during an Apple edit storm: ${paints}`);
    const settled = paints;
    await flush();
    assert.equal(paints, settled);

    const added = document.createElement("button");
    added.type = "button";
    added.id = "late-checkout";
    added.textContent = "Check Out";
    document.querySelector(".rs-bag-checkoutbuttons-wrapper")?.append(added);
    await flush();
    assert.equal(added.getAttribute("data-simmer-blocked"), "1");
    assert.ok(paints - settled <= 2, `paints after a new checkout button: ${paints - settled}`);
    const afterAdd = paints;
    await flush();
    assert.equal(paints, afterAdd);

    watch.disconnect();
  });

  it("gates a pay control the page inserts during our write, and our own writes do not storm", async () => {
    const document = new JSDOM(`<!doctype html><html><body>
      <button type="button" id="checkout">Check Out</button>
    </body></html>`, { url: "https://www.apple.com/shop/bag" }).window.document;
    const gate = installGate(document, () => appleAdapter.checkoutButtons(document));
    let paints = 0;
    const watch = watchPage(document, () => {
      paints += 1;
      if (paints > 6) {
        watch.disconnect();
        return;
      }
      watch.mute(() => gate.paint());
    });

    watch.mute(() => gate.paint());
    await flush();
    assert.equal(paints, 0, "our own paint scheduled another pass");
    assert.equal(document.querySelector("#checkout")?.getAttribute("data-simmer-blocked"), "1");

    const wrap = document.createElement("div");
    const inserted = document.createElement("button");
    inserted.type = "button";
    inserted.id = "page-checkout";
    inserted.textContent = "Checkout";
    wrap.append(inserted);
    const applePayLink = document.createElement("a");
    applePayLink.id = "page-apple-pay";
    applePayLink.href = "/shop/bagx/checkout_now";
    applePayLink.textContent = "Check Out with Apple Pay";
    const promo = document.createElement("a");
    promo.id = "page-promo";
    promo.href = "/learn";
    promo.textContent = "Learn about checkout";
    const applePay = document.createElement("button");
    applePay.type = "button";
    applePay.id = "page-apple";
    applePay.textContent = "Apple Pay";

    watch.mute(() => {
      gate.paint();
      document.body.append(wrap, applePayLink, applePay, promo);
    });

    assert.equal(inserted.getAttribute("data-simmer-blocked"), "1");
    assert.equal(applePayLink.getAttribute("data-simmer-blocked"), "1");
    assert.equal(applePay.getAttribute("data-simmer-blocked"), "1");
    assert.equal(promo.hasAttribute("data-simmer-blocked"), false);
    const afterInsert = paints;
    assert.ok(afterInsert >= 1, "page pay control was left until a later refresh");
    await flush();
    assert.equal(paints, afterInsert, `writes kept scheduling paints: ${paints}`);
    assert.ok(paints <= 3, `mutation storm: ${paints}`);
    watch.disconnect();
  });

  it("gates Proceed and Buy Now inserted during our write without waiting", async () => {
    const document = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://127.0.0.1/amazon",
    }).window.document;
    const gate = installGate(document, () => amazonAdapter.checkoutButtons(document));
    let paints = 0;
    const watch = watchPage(document, () => {
      paints += 1;
      if (paints > 6) {
        watch.disconnect();
        return;
      }
      watch.mute(() => gate.paint());
    });

    const proceed = document.createElement("input");
    proceed.type = "button";
    proceed.id = "proceed";
    proceed.value = "Proceed to checkout";
    const buyNow = document.createElement("button");
    buyNow.type = "button";
    buyNow.id = "buy-now";
    buyNow.textContent = "Buy Now";

    watch.mute(() => {
      const badge = document.createElement("span");
      badge.setAttribute("data-simmer-badge", "1");
      badge.textContent = "Marinating";
      document.body.append(badge);
      document.body.append(proceed, buyNow);
    });

    assert.equal(proceed.getAttribute("data-simmer-blocked"), "1");
    assert.equal(buyNow.getAttribute("data-simmer-blocked"), "1");
    const afterInsert = paints;
    assert.ok(afterInsert >= 1);
    await flush();
    assert.equal(paints, afterInsert, `writes kept scheduling paints: ${paints}`);
    watch.disconnect();
  });
});
