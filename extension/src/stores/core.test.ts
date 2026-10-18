import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { buttonsToBlock } from "../overlay/block.js";
import { lockPhase } from "../overlay/phase.js";
import type { StoreAdapter } from "./adapter.js";

describe("store-agnostic core", () => {
  it("hides Unlock until a reply, then keeps the lock until Unlock", () => {
    assert.equal(lockPhase({ replied: false, isUnlocked: false }), "wait-reply");
    assert.equal(lockPhase({ replied: true, isUnlocked: false }), "can-unlock");
    assert.equal(lockPhase({ replied: true, isUnlocked: true }), "open");
    assert.equal(lockPhase({ replied: false, isUnlocked: false, necessity: "necessary" }), "open");
  });

  it("blocks a fake adapter's checkout button and leaves the footer alone", () => {
    const document = new JSDOM(`<!doctype html><body>
      <footer><button id="foot">Check Out</button></footer>
      <nav><button id="nav">Apple Pay</button></nav>
      <button id="go">Check Out</button>
    </body>`).window.document;
    const adapter: StoreAdapter = {
      id: "fake",
      match: () => true,
      readBag: () => ({ items: [{ item: "Phone", price: 100, category: "test" }], total: 100 }),
      checkoutButtons: (doc) => [...doc.querySelectorAll("button")].filter((node): node is HTMLButtonElement => node.tagName === "BUTTON"),
      isOrderConfirmation: () => false,
    };
    assert.equal(adapter.readBag(document)?.total, 100);
    assert.equal(adapter.isOrderConfirmation(document), false);
    assert.deepEqual(
      buttonsToBlock(adapter, document).map((button) => button.id),
      ["go"],
    );
  });
});
