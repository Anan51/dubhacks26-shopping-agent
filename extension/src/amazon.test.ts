import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { bagWatchTargets } from "./bag-dom.js";
import { installGate } from "./gate.js";
import { buttonsToBlock } from "./overlay/block.js";
import { lockPhase } from "./overlay/phase.js";
import { watchPage } from "./page-observer.js";
import { readActiveBag } from "./store-bag.js";
import { appleAdapter } from "./stores/apple.js";
import { amazonAdapter, parseAmazonCents } from "./stores/amazon.js";
import { adapterFor } from "./stores/index.js";

const FIXTURE = new URL("../../web/amazon-cart.html", import.meta.url);

describe("amazon store adapter", () => {
  it("parses currency strings into integer cents", () => {
    assert.equal(parseAmazonCents("$179.00"), 17900);
    assert.equal(parseAmazonCents("$19.99"), 1999);
    assert.equal(parseAmazonCents("$1,299.00"), 129900);
    assert.equal(parseAmazonCents("USD 42"), 4200);
    assert.equal(parseAmazonCents("Subtotal\u00a0$8.50"), 850);
    assert.equal(parseAmazonCents("free"), null);
    assert.equal(parseAmazonCents(""), null);
  });

  it("matches amazon.com cart and checkout, plus the local fixture", () => {
    assert.equal(amazonAdapter.id, "amazon");
    assert.equal(amazonAdapter.match(locationAt("https://www.amazon.com/gp/cart/view.html")), true);
    assert.equal(amazonAdapter.match(locationAt("https://www.amazon.com/cart")), true);
    assert.equal(amazonAdapter.match(locationAt("https://www.amazon.com/checkout/p/p-123/spc")), true);
    assert.equal(amazonAdapter.match(locationAt("https://www.amazon.com/gp/buy/thankyou/handlers/display.html")), true);
    assert.equal(amazonAdapter.match(locationAt("http://127.0.0.1:4321/amazon")), true);
    assert.equal(amazonAdapter.match(locationAt("http://localhost:4321/amazon/")), true);
    assert.equal(amazonAdapter.match(locationAt("https://www.amazon.com/dp/B000000")), false);
    assert.equal(amazonAdapter.match(locationAt("https://www.apple.com/shop/bag")), false);
    assert.equal(amazonAdapter.match(locationAt("https://www.amazon.co.uk/gp/cart/view.html")), false);
    assert.equal(appleAdapter.match(locationAt("http://127.0.0.1:4321/amazon")), false);
    assert.equal(adapterFor(locationAt("http://127.0.0.1:4321/amazon"))?.id, "amazon");
    assert.equal(adapterFor(locationAt("https://www.apple.com/shop/bag"))?.id, "apple");
  });

  it("reads the local cart fixture: several items, quantities, and integer cents", () => {
    const doc = fixtureDocument();
    assert.equal(amazonAdapter.isOrderConfirmation(doc), false);
    assert.deepEqual(amazonAdapter.readBag(doc), {
      items: [
        { item: "Noise-cancelling headphones", price: 3998, category: "audio", quantity: 2 },
        { item: "Phone case", price: 1200, category: "case", quantity: 1 },
      ],
      total: 5198,
      quantity: 2,
    });
    const page = readActiveBag(amazonAdapter, doc);
    assert.equal(page.parsed, true);
    assert.deepEqual(page.itemNames, ["Noise-cancelling headphones", "Phone case"]);
    assert.equal(page.quantity, 2);
    assert.equal(page.items[1]?.quantity, 1);
    assert.equal(page.totalCents, 5198);
    assert.equal(Number.isInteger(page.totalCents), true);
    const watched = bagWatchTargets(doc);
    assert.equal(watched.length, 1);
    assert.equal(watched[0]?.contains(doc.querySelector("#sc-active-cart")), true);
    assert.equal(watched[0]?.contains(doc.querySelector("#proceed")), false);
  });

  it("multiplies a unit price by quantity and ignores a struck list price", () => {
    const doc = page(
      "https://www.amazon.com/gp/cart/view.html",
      `<body><div id="sc-active-cart">
        <div data-asin="B001" class="sc-list-item">
          <span class="sc-product-title">USB-C Cable</span>
          <span class="a-price" data-a-strike="true"><span class="a-offscreen">$40.00</span></span>
          <span class="a-price"><span class="a-offscreen">$19.99</span></span>
          <select name="quantity" aria-hidden="true"><option value="9" selected>9</option></select>
          <select name="quantity"><option value="1">1</option><option value="2" selected>2</option></select>
        </div>
        <div data-asin="B002" class="sc-list-item">
          <span class="a-truncate-full">Phone case</span>
          <span class="sc-product-price">$5.50</span>
          <span class="a-dropdown-prompt">Qty: 3</span>
        </div>
      </div>
      <span id="sc-subtotal-amount-activecart"><span class="a-offscreen">$56.48</span></span></body>`,
    );
    assert.deepEqual(amazonAdapter.readBag(doc), {
      items: [
        { item: "USB-C Cable", price: 3998, category: "cable", quantity: 2 },
        { item: "Phone case", price: 1650, category: "case", quantity: 3 },
      ],
      total: 5648,
      quantity: 2,
    });
  });

  it("returns null when any line has no parseable price", () => {
    const doc = page(
      "https://www.amazon.com/gp/cart/view.html",
      `<body><div id="sc-active-cart">
        <div data-asin="B001" class="sc-list-item"><span class="sc-product-title">USB-C Cable</span><span class="sc-product-price">$19.99</span></div>
        <div data-asin="B002" class="sc-list-item"><span class="sc-product-title">Gift wrap</span><span class="sc-product-price">free</span></div>
      </div></body>`,
    );
    assert.equal(amazonAdapter.readBag(doc), null);
  });

  it("locks Proceed to checkout and Buy Now on the fixture, then restores them", () => {
    const doc = fixtureDocument();
    const proceed = control(doc, "#proceed");
    const buyNow = control(doc, "#buy-now");
    const remove = control(doc, "#remove");
    const nav = control(doc, "#nav-proceed");
    const footer = control(doc, "#footer-buy");
    assert.equal(lockPhase({ replied: false, isUnlocked: false, necessity: "unnecessary" }), "wait-reply");

    const gate = installGate(doc, () => buttonsToBlock(amazonAdapter, doc));
    gate.paint();

    for (const button of [proceed, buyNow]) {
      assert.equal(button.getAttribute("data-simmer-blocked"), "1");
      assert.equal(button.getAttribute("aria-disabled"), "true");
      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute("data-simmer-disabled"), "1");
      assert.equal(button.nextElementSibling?.getAttribute("data-simmer-badge"), "1");
      assert.equal(click(button).defaultPrevented, true);
    }
    for (const button of [remove, nav, footer]) {
      assert.equal(button.hasAttribute("data-simmer-blocked"), false);
      assert.equal(button.disabled, false);
      assert.equal(click(button).defaultPrevented, false);
    }

    gate.lift();
    for (const button of [proceed, buyNow]) {
      assert.equal(button.disabled, false);
      assert.equal(button.hasAttribute("data-simmer-blocked"), false);
      assert.equal(button.hasAttribute("data-simmer-disabled"), false);
      assert.equal(button.hasAttribute("aria-disabled"), false);
      assert.equal(click(button).defaultPrevented, false);
    }
    assert.equal(proceed.value, "Proceed to checkout");
    assert.equal(buyNow.value, "Buy Now");
    assert.equal(doc.querySelector("[data-simmer-badge]"), null);
    assert.equal(doc.querySelector("[data-simmer-blocked]"), null);
  });

  it("does not lock checkout when the bag is necessary", () => {
    const doc = page(
      "http://127.0.0.1:4321/amazon",
      `<body><div id="sc-active-cart">
        <div data-asin="B010" class="sc-list-item">
          <span class="sc-product-title">USB-C charge cable</span>
          <span class="a-price"><span class="a-offscreen">$19.00</span></span>
          <select name="quantity"><option value="1" selected>1</option></select>
        </div>
        <span id="sc-subtotal-amount-activecart"><span class="a-offscreen">$19.00</span></span>
      </div>
      <input id="proceed" name="proceedToRetailCheckout" type="button" value="Proceed to checkout" />
      <input id="buy-now" type="button" value="Buy Now" /></body>`,
    );
    assert.equal(amazonAdapter.readBag(doc)?.total, 1900);
    assert.equal(amazonAdapter.readBag(doc)?.quantity, 1);
    assert.equal(lockPhase({ replied: false, isUnlocked: true, necessity: "necessary" }), "open");
    const proceed = control(doc, "#proceed");
    const buyNow = control(doc, "#buy-now");
    const gate = installGate(doc, () => buttonsToBlock(amazonAdapter, doc));
    gate.lift();
    for (const button of [proceed, buyNow]) {
      assert.equal(button.disabled, false);
      assert.equal(button.hasAttribute("data-simmer-blocked"), false);
      assert.equal(click(button).defaultPrevented, false);
    }
  });

  it("stops repainting once the Amazon fixture lock has settled", async () => {
    const doc = fixtureDocument();
    const view = doc.defaultView;
    assert.ok(view);
    assert.equal(typeof view.MutationObserver, "function");
    const proceed = control(doc, "#proceed");
    const buyNow = control(doc, "#buy-now");
    let paints = 0;
    let showBlock = true;
    const gate = installGate(doc, () => buttonsToBlock(amazonAdapter, doc));
    const watch = watchPage(doc, () => {
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
    assert.equal(proceed.getAttribute("data-simmer-blocked"), "1");
    assert.equal(buyNow.getAttribute("data-simmer-blocked"), "1");
    assert.equal(proceed.disabled, true);

    const afterLoad = paints;
    const note = doc.querySelector(".note");
    assert.ok(note);
    note.textContent = "Hours";
    await flush();
    assert.ok(paints - afterLoad <= 3, `paints after an unrelated change: ${paints - afterLoad}`);

    showBlock = false;
    gate.lift();
    await flush();
    for (const button of [proceed, buyNow]) {
      assert.equal(button.disabled, false);
      assert.equal(button.hasAttribute("data-simmer-blocked"), false);
      assert.equal(button.hasAttribute("data-simmer-disabled"), false);
      assert.equal(button.hasAttribute("aria-disabled"), false);
    }
    assert.equal(doc.querySelector("[data-simmer-badge]"), null);
    watch.disconnect();
  });

  it("keeps an Apple bag on the Apple reader", () => {
    const doc = page(
      "https://www.apple.com/shop/bag",
      `<body><ul><li class="rs-bag-item" data-autom="bag-item-1">
        <h2 class="rs-iteminfo-title"><a data-autom="bag-item-name">iPhone 17 256GB</a></h2>
        <select data-autom="item-quantity-dropdown"><option value="1" selected>1</option></select>
        <div data-autom="Monthly_price"><p>$1,027.01</p></div>
      </li></ul><div data-autom="bagtotalvalue">$1,027.01</div></body>`,
    );
    const bag = readActiveBag(appleAdapter, doc);
    assert.deepEqual(bag.itemNames, ["iPhone 17 256GB"]);
    assert.equal(bag.quantity, 1);
    assert.equal(bag.totalCents, 102_701);
  });
});

function fixtureDocument(): Document {
  const html = readFileSync(FIXTURE, "utf8");
  return new JSDOM(html, { url: "http://127.0.0.1:4321/amazon" }).window.document;
}

function locationAt(href: string): Location {
  return new JSDOM("<!doctype html><body></body>", { url: href }).window.location;
}

function page(href: string, body: string): Document {
  return new JSDOM(`<!doctype html>${body}`, { url: href }).window.document;
}

function control(doc: Document, selector: string): HTMLInputElement {
  const node = doc.querySelector(selector);
  assert.ok(node instanceof doc.defaultView?.HTMLInputElement || node instanceof doc.defaultView?.HTMLButtonElement);
  return node as HTMLInputElement;
}

function click(button: Element): Event {
  const view = button.ownerDocument.defaultView;
  assert.ok(view);
  const event = new view.MouseEvent("click", { bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  return event;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
