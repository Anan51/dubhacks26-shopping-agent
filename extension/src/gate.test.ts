import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { BLOCKED_STYLE_ID, installGate } from "./gate.js";

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
    assert.ok(style?.textContent?.includes('content: "Marinating"'));
    assert.match(style?.textContent ?? "", /opacity:\s*0\.45/);
    assert.match(style?.textContent ?? "", /grayscale\(1\)/);
    assert.match(style?.textContent ?? "", /cursor:\s*not-allowed/);
    assert.match(style?.textContent ?? "", /pointer-events:\s*none/);
    assert.equal(style?.textContent?.includes("button {"), false);

    for (const button of [checkout, apple, pay, go]) {
      assert.equal(button.getAttribute("data-simmer-blocked"), "1");
      assert.equal(button.getAttribute("aria-disabled"), "true");
    }
    assert.equal(checkout.disabled, true);
    assert.equal(checkout.getAttribute("data-simmer-disabled"), "1");
    assert.equal(checkout.textContent, "Check Out");
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
});
