import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { readPageBag } from "./bag-dom.js";
import { installGate } from "./gate.js";
import { watchPage } from "./page-observer.js";

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
});
