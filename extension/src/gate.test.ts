import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { readPageBag } from "./bag-dom.js";
import { BLOCKED_STYLE_ID, installGate } from "./gate.js";
import { appleAdapter } from "./stores/apple.js";

const FALLBACK_HTML = new URL("../../web/fallback.html", import.meta.url);

function bagDocument(): Document {
  return new JSDOM(`<!doctype html><html><head></head><body>
    <button type="button" id="checkout">Check Out</button>
    <button type="button" id="apple">Apple Pay</button>
    <apple-pay-button id="pay"></apple-pay-button>
    <button type="button" id="remove">Remove</button>
    <button type="button" id="already" disabled>Check Out</button>
    <input id="go" type="submit" aria-label="Check Out" value="Check Out" />
  </body></html>`).window.document;
}

function button(document: Document, id: string): HTMLButtonElement {
  const node = document.querySelector(`#${id}`);
  assert.equal(node?.tagName, "BUTTON");
  return node as HTMLButtonElement;
}

function click(button: Element): Event {
  const view = button.ownerDocument.defaultView;
  assert.ok(view);
  const event = new view.MouseEvent("click", { bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  return event;
}

describe("checkout gate", () => {
  it("grays out blocked checkout buttons, labels them, and restores only what it changed", () => {
    const document = bagDocument();
    const checkout = button(document, "checkout");
    const apple = button(document, "apple");
    const pay = document.querySelector("#pay");
    const remove = button(document, "remove");
    const already = button(document, "already");
    const go = document.querySelector("#go") as HTMLInputElement;
    assert.equal(pay?.tagName, "APPLE-PAY-BUTTON");
    assert.equal(go.tagName, "INPUT");
    assert.ok(pay);

    const gate = installGate(document, "bag");
    gate.paint();

    const style = document.getElementById(BLOCKED_STYLE_ID);
    assert.match(style?.textContent ?? "", /\[data-simmer-badge\]/);
    assert.match(style?.textContent ?? "", /background:\s*#1c1c1e/);
    assert.match(style?.textContent ?? "", /color:\s*#fff/);
    assert.match(style?.textContent ?? "", /opacity:\s*0\.45/);
    assert.match(style?.textContent ?? "", /grayscale\(1\)/);
    assert.match(style?.textContent ?? "", /cursor:\s*not-allowed/);
    assert.match(style?.textContent ?? "", /pointer-events:\s*none/);
    assert.equal(style?.textContent?.includes("button {"), false);
    assert.equal(style?.textContent?.includes("::after"), false);

    for (const button of [checkout, apple, pay, go]) {
      assert.equal(button.getAttribute("data-simmer-blocked"), "1");
      assert.equal(button.getAttribute("aria-disabled"), "true");
    }
    assert.equal(checkout.disabled, true);
    assert.equal(checkout.getAttribute("data-simmer-disabled"), "1");
    assert.equal(checkout.textContent, "Check Out");
    const badge = checkout.nextElementSibling;
    assert.equal(badge?.getAttribute("data-simmer-badge"), "1");
    assert.equal(badge?.textContent, "Marinating");
    assert.equal(badge?.hasAttribute("data-simmer-blocked"), false);
    assert.equal(go.disabled, true);
    assert.equal(go.getAttribute("data-simmer-disabled"), "1");
    assert.equal(go.value, "Check Out");
    assert.equal(pay.hasAttribute("data-simmer-disabled"), false);
    assert.equal(remove.hasAttribute("data-simmer-blocked"), false);
    assert.equal(remove.disabled, false);
    assert.equal(already.disabled, true);
    assert.equal(already.getAttribute("data-simmer-disabled"), null);
    assert.equal(already.getAttribute("data-simmer-blocked"), "1");
    assert.equal(click(checkout).defaultPrevented, true);

    checkout.remove();
    const replacement = document.createElement("button");
    replacement.type = "button";
    replacement.textContent = "Check Out";
    document.body.append(replacement);
    gate.paint();
    assert.equal(replacement.disabled, true);
    assert.equal(replacement.getAttribute("data-simmer-disabled"), "1");
    assert.equal(replacement.getAttribute("data-simmer-blocked"), "1");
    assert.equal(replacement.textContent, "Check Out");
    assert.equal(click(replacement).defaultPrevented, true);

    gate.lift();
    assert.equal(document.getElementById(BLOCKED_STYLE_ID), null);
    assert.equal(document.querySelector("[data-simmer-badge]"), null);
    assert.equal(replacement.disabled, false);
    assert.equal(replacement.hasAttribute("data-simmer-blocked"), false);
    assert.equal(replacement.hasAttribute("data-simmer-disabled"), false);
    assert.equal(replacement.hasAttribute("aria-disabled"), false);
    assert.equal(replacement.textContent, "Check Out");
    assert.equal(go.disabled, false);
    assert.equal(go.value, "Check Out");
    assert.equal(apple.hasAttribute("data-simmer-blocked"), false);
    assert.equal(pay.hasAttribute("data-simmer-blocked"), false);
    assert.equal(already.disabled, true);
    assert.equal(already.hasAttribute("data-simmer-blocked"), false);
    assert.equal(click(replacement).defaultPrevented, false);
    assert.equal(click(already).defaultPrevented, false);
  });

  it("leaves footer, nav, and global chrome alone and still blocks checkout buttons", () => {
    const document = new JSDOM(`<!doctype html><html><body>
      <footer><a id="footer-link" href="/apple-pay/">Apple Pay</a></footer>
      <nav><a id="nav-link" href="/shop/browse/finance/apple_pay">Apple Pay</a></nav>
      <div id="globalheader"><a id="header-link" href="/apple-pay/">Apple Pay</a></div>
      <div id="globalfooter"><button id="footer-checkout" type="button">Check Out</button></div>
      <button type="button" id="checkout">Check Out</button>
      <button type="button" id="apple">Apple Pay</button>
      <apple-pay-button id="pay"></apple-pay-button>
      <button type="button" id="card">Pay with Apple Card</button>
      <a id="plain-checkout" href="/shop/bagx/checkout_now">Check Out</a>
      <a id="check-lower" href="/shop/bagx/checkout_now">Check out</a>
      <a id="check-break" href="/shop/bagx/checkout_now">  Check\n Out </a>
      <a id="check-upper" href="/shop/bagx/checkout_now">CHECK OUT</a>
      <a id="check-spans" href="/shop/bagx/checkout_now"><span>Check</span> <span>Out</span></a>
      <button type="button" id="checkout-word">Checkout</button>
      <a id="checkout-word-link" href="/shop/bagx/checkout_now">Checkout</a>
      <a id="aria-checkout" href="/shop/bagx/checkout_now" aria-label="Checkout"></a>
      <a id="apple-pay-checkout" href="/shop/bagx/checkout_now">Check Out with Apple Pay</a>
      <a id="apple-pay-spans" href="/shop/bagx/checkout_now"><span>Check Out</span> <span>with Apple Pay</span></a>
      <a id="promo" href="/shop/buy-iphone">Check out our new iPhone deals</a>
      <a id="learn-checkout" href="/shop/buy-iphone">Learn about checkout</a>
      <a id="checkout-tips" href="/shop/buy-iphone">Checkout tips</a>
      <a id="learn" href="/apple-card/">Learn more about Apple Card Monthly Installments</a>
    </body></html>`).window.document;
    const gate = installGate(document, "bag");
    gate.paint();
    for (const id of ["footer-link", "nav-link", "header-link", "footer-checkout", "learn", "promo", "learn-checkout", "checkout-tips"]) {
      const node = document.querySelector(`#${id}`);
      assert.ok(node);
      assert.equal(node.hasAttribute("data-simmer-blocked"), false, id);
      assert.equal(click(node).defaultPrevented, false, id);
    }
    for (const id of ["checkout", "apple", "pay", "card", "plain-checkout", "check-lower", "check-break", "check-upper", "check-spans", "checkout-word", "checkout-word-link", "aria-checkout", "apple-pay-checkout", "apple-pay-spans"]) {
      const node = document.querySelector(`#${id}`);
      assert.ok(node);
      assert.equal(node.getAttribute("data-simmer-blocked"), "1", id);
      assert.equal(node.nextElementSibling?.textContent, "Marinating", id);
      assert.equal(click(node).defaultPrevented, true, id);
    }
    gate.lift();
    assert.equal(document.querySelector("[data-simmer-badge]"), null);
    assert.equal(document.querySelector("#checkout")?.hasAttribute("data-simmer-blocked"), false);
  });

  it("on a locked or vaulted Apple bag, blocks only Check Out and Apple Pay", () => {
    const html = readFileSync(FALLBACK_HTML, "utf8");
    const document = new JSDOM(html, { url: "https://www.apple.com/shop/bag" }).window.document;
    const simmer = document.createElement("div");
    simmer.id = "simmer-root";
    const unlock = document.createElement("button");
    unlock.id = "simmer-unlock";
    unlock.type = "button";
    unlock.textContent = "Unlock";
    simmer.append(unlock);
    document.body.append(simmer);

    const bag = readPageBag(document.body);
    assert.equal(bag.parsed, true);
    assert.deepEqual(bag.itemNames, ["Example phone"]);
    assert.equal(bag.totalCents, 120_000);

    const shell = document.querySelector("#page");
    assert.equal(shell?.getAttribute("role"), "button");
    const gate = installGate(document, () => appleAdapter.checkoutButtons(document));
    gate.paint();
    assertOnlyPayBlocked(document);

    // Vault uses the same paint while the bag stays closed.
    gate.paint();
    assertOnlyPayBlocked(document);

    gate.lift();
    for (const id of ["checkout", "apple-pay", "remove", "nav-store", "nav-mac", "nav-bag", "continue", "product", "foot-pay", "foot-home", "simmer-unlock"]) {
      const node = document.querySelector(`#${id}`);
      assert.ok(node, id);
      assert.equal(node.hasAttribute("data-simmer-blocked"), false, id);
      assert.equal(node.hasAttribute("data-simmer-disabled"), false, id);
      assert.equal(node.hasAttribute("aria-disabled"), false, id);
      assert.equal(node.hasAttribute("disabled"), false, id);
      assert.equal(click(node).defaultPrevented, false, id);
    }
    assert.equal(document.querySelector("[data-simmer-badge]"), null);
    assert.equal(document.querySelector("[data-simmer-blocked]"), null);
  });
});

function assertOnlyPayBlocked(document: Document): void {
  const payIds = ["checkout", "apple-pay"];
  for (const id of payIds) {
    const node = document.querySelector(`#${id}`);
    assert.ok(node, id);
    assert.equal(node.getAttribute("data-simmer-blocked"), "1", id);
    assert.equal(node.getAttribute("aria-disabled"), "true", id);
    assert.equal(click(node).defaultPrevented, true, id);
  }
  const openIds = ["remove", "nav-store", "nav-mac", "nav-bag", "continue", "product", "foot-pay", "foot-home", "simmer-unlock", "qty", "page"];
  for (const id of openIds) {
    const node = document.querySelector(`#${id}`);
    assert.ok(node, id);
    assert.equal(node.hasAttribute("data-simmer-blocked"), false, id);
    assert.equal(node.hasAttribute("data-simmer-disabled"), false, id);
    assert.equal(node.getAttribute("aria-disabled"), null, id);
    assert.equal(node.hasAttribute("disabled"), false, id);
    assert.equal([...node.attributes].some((attribute) => attribute.name.startsWith("data-simmer")), false, id);
    assert.equal(click(node).defaultPrevented, false, id);
  }
}
