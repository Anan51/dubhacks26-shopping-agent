import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const { shouldInjectContent } = createRequire(import.meta.url)("../page-match.mjs") as {
  shouldInjectContent: (url: string) => boolean;
};

describe("content script injection urls", () => {
  it("injects bag urls including a query, a secure store host, and a pushState cart", () => {
    for (const url of [
      "https://www.apple.com/shop/bag",
      "https://www.apple.com/shop/bag?pr=1",
      "https://apple.com/shop/bag/",
      "https://www.apple.com/uk/shop/bag",
      "https://secure8.store.apple.com/shop/bag",
      "https://secure.store.apple.com/us/shop/bag?x=1",
      "https://secure6.store.apple.com/shop/checkout",
      "http://127.0.0.1:4321/fallback",
      "http://localhost:4321/amazon",
      "http://127.0.0.1:4321/carrier-switch",
      "http://127.0.0.1:4321/carrier-switch?case=pass",
      "https://www.amazon.com/gp/cart/view.html",
      "https://www.amazon.com/cart",
    ]) {
      assert.equal(shouldInjectContent(url), true, url);
    }
  });

  it("leaves product and buy-flow pages alone", () => {
    for (const url of [
      "https://www.apple.com/shop/buy-iphone/iphone-17",
      "https://www.apple.com/shop/product/mw2l3am/a/usb-c-charge-cable",
      "https://www.apple.com/",
      "https://www.amazon.com/s?k=cable",
      "https://example.com/shop/bag",
    ]) {
      assert.equal(shouldInjectContent(url), false, url);
    }
  });
});
