import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { bindCheckoutClicks } from "./checkout-record.js";
import { appleAdapter } from "./stores/apple.js";

describe("checkout click recording", () => {
  it("records one Apple checkout click after unlock and ignores a second click", async () => {
    const dom = new JSDOM(
      `<!doctype html><body>
        <footer><button type="button" id="footer">Check Out</button></footer>
        <button type="button" id="checkout">Check Out</button>
        <button type="button" id="remove">Remove</button>
      </body>`,
      { url: "https://www.apple.com/shop/bag" },
    );
    const doc = dom.window.document;
    const bag = { code: "AB23CD", unlocked: false };
    const codes: string[] = [];
    bindCheckoutClicks(
      doc,
      () => appleAdapter.checkoutButtons(doc),
      () => bag,
      (code) => {
        codes.push(code);
      },
    );

    click(doc, "#checkout");
    click(doc, "#remove");
    assert.deepEqual(codes, []);

    bag.unlocked = true;
    click(doc, "#footer");
    click(doc, "#remove");
    assert.deepEqual(codes, []);

    click(doc, "#checkout");
    click(doc, "#checkout");
    assert.deepEqual(codes, ["AB23CD"]);
  });
});

function click(doc: Document, selector: string): void {
  const node = doc.querySelector(selector);
  assert.ok(node);
  const view = doc.defaultView;
  assert.ok(view);
  node.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
}
