import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { applePage, isFallbackBag, isLocalAmazonFixture, isLocalCarrierFixture, shouldEngage } from "./sites.js";

const MANIFEST = new URL("../extension/manifest.json", import.meta.url);

describe("apple pages", () => {
  it("matches the bag and regional checkout hosts", () => {
    assert.equal(applePage("https://www.apple.com/shop/bag"), "bag");
    assert.equal(applePage("https://www.apple.com/shop/bag/"), "bag");
    assert.equal(applePage("https://www.apple.com/shop/bag?pr=1"), "bag");
    assert.equal(applePage("https://apple.com/shop/bag"), "bag");
    assert.equal(applePage("https://www.apple.com/uk/shop/bag"), "bag");
    assert.equal(applePage("https://www.apple.com/ca/shop/bag?ref=nav"), "bag");
    assert.equal(applePage("https://www.apple.com.cn/shop/bag"), "bag");
    assert.equal(applePage("https://secure6.store.apple.com/shop/bag"), "bag");
    assert.equal(applePage("https://secure.store.apple.com/us/shop/bag?pr=1"), "bag");
    assert.equal(applePage("https://secure6.store.apple.com/shop/checkout"), "checkout");
    assert.equal(applePage("https://secure.store.apple.com/us/shop/checkout/start"), "checkout");
    assert.equal(applePage("https://www.apple.com/shop/buy-iphone"), null);
    assert.equal(applePage("https://www.apple.com/shop/buy-iphone/iphone-17"), null);
    assert.equal(applePage("https://www.apple.com/shop/buy-iphone/iphone-17/accessories"), null);
    assert.equal(applePage("https://www.apple.com/shop/product/mw2l3am/a/usb-c-charge-cable"), null);
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
    assert.equal(shouldEngage("http://127.0.0.1:4321/fallback/cable", []), true);
    assert.equal(shouldEngage("http://localhost:4321/fallback", []), true);
    assert.equal(shouldEngage("http://127.0.0.1:4321/amazon", []), false);
    assert.equal(shouldEngage("http://127.0.0.1:4321/carrier-switch", []), false);
    assert.equal(shouldEngage("http://127.0.0.1:4321/carrier-switch?case=pass", []), false);
    assert.equal(shouldEngage("http://127.0.0.1:4321/dev", []), false);
    assert.equal(applePage("http://127.0.0.1:4321/amazon"), null);
    assert.equal(isLocalAmazonFixture("http://127.0.0.1:4321/amazon"), true);
    assert.equal(isLocalAmazonFixture("http://localhost:4321/amazon/"), true);
    assert.equal(isLocalAmazonFixture("https://www.amazon.com/gp/cart/view.html"), false);
    assert.equal(isFallbackBag("http://127.0.0.1:4321/amazon"), true);
    assert.equal(isFallbackBag("http://127.0.0.1:4321/fallback"), true);
    assert.equal(isFallbackBag("http://127.0.0.1:4321/carrier-switch"), true);
    assert.equal(isLocalCarrierFixture("http://127.0.0.1:4321/carrier-switch?case=wait"), true);
    assert.equal(isLocalCarrierFixture("http://localhost:4321/carrier-switch/"), true);
    assert.equal(isLocalCarrierFixture("https://www.verizon.com/"), false);
    assert.equal(applePage("http://127.0.0.1:4321/carrier-switch"), null);
  });

  it("does not inject the content script on product or buy-flow pages", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      content_scripts: { matches: string[] }[];
    };
    const patterns = manifest.content_scripts.flatMap((script) => script.matches);
    for (const url of [
      "https://www.apple.com/shop/buy-iphone/iphone-17",
      "https://www.apple.com/shop/buy-iphone/iphone-17/accessories",
      "https://www.apple.com/shop/product/mw2l3am/a/usb-c-charge-cable",
      "https://www.apple.com/shop/accessories/all",
    ]) {
      assert.equal(patterns.some((pattern) => matchPattern(pattern, url)), false, url);
    }
    for (const url of [
      "https://www.apple.com/shop/bag",
      "https://www.apple.com/shop/bag?pr=1",
      "https://apple.com/shop/bag",
      "https://www.apple.com/uk/shop/bag",
      "https://secure6.store.apple.com/shop/bag",
      "https://secure.store.apple.com/us/shop/bag",
      "https://secure6.store.apple.com/shop/checkout",
      "http://127.0.0.1:4321/fallback",
      "http://127.0.0.1:4321/carrier-switch",
      "http://localhost:4321/carrier-switch",
    ]) {
      assert.equal(patterns.some((pattern) => matchPattern(pattern, url)), true, url);
    }
  });
});

function matchPattern(pattern: string, url: string): boolean {
  const parsed = new URL(url);
  const match = /^(\*|https?|http):\/\/(\*|[^/]+)(\/.*)$/.exec(pattern);
  if (!match) {
    return false;
  }
  const scheme = match[1] ?? "";
  const host = match[2] ?? "";
  const path = match[3] ?? "/";
  const protocol = parsed.protocol.replace(":", "");
  if (scheme === "*") {
    if (protocol !== "http" && protocol !== "https") {
      return false;
    }
  } else if (scheme !== protocol) {
    return false;
  }
  if (!hostMatches(host, parsed)) {
    return false;
  }
  const expression = `^${path.split("*").map(escapeRegex).join(".*")}$`;
  return new RegExp(expression).test(parsed.pathname);
}

function hostMatches(pattern: string, parsed: URL): boolean {
  if (pattern === "*") {
    return true;
  }
  const portAt = pattern.lastIndexOf(":");
  const host = portAt === -1 ? pattern : pattern.slice(0, portAt);
  const port = portAt === -1 ? "" : pattern.slice(portAt + 1);
  if (port !== "" && parsed.port !== port) {
    return false;
  }
  if (host.startsWith("*.")) {
    const rest = host.slice(2);
    return parsed.hostname === rest || parsed.hostname.endsWith(`.${rest}`);
  }
  return parsed.hostname === host;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
