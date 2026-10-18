import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { bagOrFallback, FALLBACK_TOTAL_CENTS, interpretBag, isBlockedControl } from "./apple-bag.js";

const SNAPSHOT = new URL("../extension/fixtures/apple-bag-snapshot.txt", import.meta.url);

describe("Apple bag snapshot", () => {
  it("reads item names and the subtotal without class selectors", () => {
    const lines = readFileSync(SNAPSHOT, "utf8").split("\n");
    const bag = interpretBag(lines);
    assert.equal(bag.parsed, true);
    assert.equal(bag.totalCents, 119_900);
    assert.deepEqual(bag.itemNames, ["iPhone 16 Pro"]);
    const ready = bagOrFallback(bag);
    assert.equal(ready.parsed, true);
    assert.equal(ready.totalCents, 119_900);
  });

  it("reads a live Apple bag where the title repeats above Subtotal", () => {
    const bag = interpretBag([
      "Mac",
      "iPhone",
      "Learn more about Apple Card Monthly Installments",
      "Wrist Strap – Burgundy",
      "Quantity for Wrist Strap – Burgundy",
      "1",
      "$29.00 or",
      "$2.41/mo.",
      "Remove",
      "Wrist Strap – Burgundy",
      "Save for later",
      "Wrist Strap – Burgundy",
      "In stock and ready to ship.",
      "Subtotal",
      "$29.00",
      "Shipping",
      "FREE",
      "Total",
      "$29.00",
      "Check Out",
    ]);
    assert.equal(bag.parsed, true);
    assert.equal(bag.totalCents, 2_900);
    assert.deepEqual(bag.itemNames, ["Wrist Strap – Burgundy"]);
    const withLaterPrice = interpretBag([
      ...[
        "Wrist Strap – Burgundy",
        "Wrist Strap – Burgundy",
        "Subtotal",
        "$29.00",
        "Pay in Full",
        "$29.00",
      ],
    ]);
    assert.deepEqual(withLaterPrice.itemNames, ["Wrist Strap – Burgundy"]);
    assert.equal(withLaterPrice.totalCents, 2_900);
  });

  it("reads the product name that sits above the subtotal", () => {
    const bag = interpretBag([
      "Fallback bag. Example data. Open this only when apple.com will not load. Simmer reads the product name and the bag total, then waits. This page never takes a card.",
      "Example phone",
      "Bag Subtotal",
      "$1,200.00",
      "Check Out",
    ]);
    assert.equal(bag.parsed, true);
    assert.equal(bag.totalCents, 120_000);
    assert.deepEqual(bag.itemNames, ["Example phone"]);
  });

  it("falls back to the example phone when the total is missing", () => {
    const ready = bagOrFallback(interpretBag(["Shopping Bag", "Check Out"]));
    assert.equal(ready.parsed, false);
    assert.equal(ready.totalCents, FALLBACK_TOTAL_CENTS);
    assert.deepEqual(ready.itemNames, ["Example phone"]);
  });
});

describe("checkout controls", () => {
  it("treats Check Out and Apple Pay as the bag lock, and pay controls on checkout", () => {
    const checkOut = { tag: "button", text: "Check Out", ariaLabel: "" };
    const applePay = { tag: "apple-pay-button", text: "", ariaLabel: "Apple Pay" };
    const remove = { tag: "button", text: "Remove", ariaLabel: "Remove iPhone 16 Pro" };
    const pay = { tag: "button", text: "Pay", ariaLabel: "" };
    assert.equal(isBlockedControl(checkOut, "bag"), true);
    assert.equal(isBlockedControl(applePay, "bag"), true);
    assert.equal(isBlockedControl(remove, "bag"), false);
    assert.equal(isBlockedControl(pay, "bag"), false);
    assert.equal(isBlockedControl({ tag: "button", text: "Check out with Pay", ariaLabel: "" }, "bag"), true);
    assert.equal(
      isBlockedControl({ tag: "a", text: "Learn more about Apple Payment & Pricing", ariaLabel: "" }, "bag"),
      false,
    );
    assert.equal(isBlockedControl(pay, "checkout"), true);
  });
});
