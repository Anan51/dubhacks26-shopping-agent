import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applePage, shouldEngage } from "./sites.js";

describe("apple pages", () => {
  it("matches the bag and regional checkout hosts", () => {
    assert.equal(applePage("https://www.apple.com/shop/bag"), "bag");
    assert.equal(applePage("https://www.apple.com/shop/bag/"), "bag");
    assert.equal(applePage("https://www.apple.com/uk/shop/bag"), "bag");
    assert.equal(applePage("https://www.apple.com/ca/shop/bag?ref=nav"), "bag");
    assert.equal(applePage("https://www.apple.com.cn/shop/bag"), "bag");
    assert.equal(applePage("https://secure6.store.apple.com/shop/checkout"), "checkout");
    assert.equal(applePage("https://secure.store.apple.com/us/shop/checkout/start"), "checkout");
    assert.equal(applePage("https://www.apple.com/shop/buy-iphone"), null);
    assert.equal(applePage("https://example.com/shop/bag"), null);
  });

  it("keeps apple.com enabled until it is opted out", () => {
    const bag = "https://www.apple.com/uk/shop/bag";
    const checkout = "https://secure2.store.apple.com/shop/checkout";
    assert.equal(shouldEngage(bag, []), true);
    assert.equal(shouldEngage(checkout, []), true);
    assert.equal(shouldEngage(bag, ["apple.com"]), false);
    assert.equal(shouldEngage(checkout, ["apple.com"]), false);
    assert.equal(shouldEngage(bag, ["example.com"]), true);
    assert.equal(shouldEngage("https://www.apple.com/", []), false);
    assert.equal(shouldEngage("http://127.0.0.1:4321/fallback", []), true);
    assert.equal(shouldEngage("http://localhost:4321/fallback", []), true);
    assert.equal(shouldEngage("http://127.0.0.1:4321/dev", []), false);
  });
});
