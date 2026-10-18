import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { bagContentKey, bagReadAction, quantityTotalLabel, readPageBag } from "./bag-dom.js";

const CABLE_FIXTURE = new URL("../fixtures/apple-bag-cable-row.html", import.meta.url);

const CABLE_ROW = `<li class="rs-bag-item rs-iteminfo-wrap" data-autom="bag-item-1" role="listitem"><div class="rs-iteminfo row"><div class="rs-iteminfo-image column large-3 small-12"><picture><img data-autom="bag-item-image" alt="cable" src="https://store.storeimages.cdn-apple.com/x/MQKJ3"></picture></div><div class="rs-iteminfo-content column large-9 small-12"><div class="rs-iteminfo-details"><div class="rs-iteminfo-title-wrapper large-6 small-12"><h2 class="rs-iteminfo-title"><a href="/shop/product/mw493am/a/60w-usb-c-charge-cable-1-m" data-evar1="Cart||MW493AM/A" data-autom="bag-item-name">60W USB-C Charge Cable (1\u00a0m)</a></h2></div><div class="rs-iteminfo-quantity"><div class="rs-quantity"><div class="rs-quantity-selector"><div class="rs-quantity-wrapper form-dropdown"><label class="visuallyhidden">Quantity for 60W USB-C Charge Cable (1\u00a0m)</label><select class="rs-quantity-dropdown form-dropdown-select" data-autom="item-quantity-dropdown"><option value="1">1</option><option value="9">9</option><option value="10">10+</option></select><select aria-hidden="true" class="rs-quantity-hidden-select"><option>1</option></select></div></div></div></div><div class="rs-iteminfo-pricedetails large-last"><div data-autom="Monthly_price" class="rs-iteminfo-price"><p>$19.00</p></div></div></div></div></div></li>`;

const TOTALS = `<div class="rs-summary-value" data-autom="bagtotalvalue">$21.00</div><div class="rs-summary-value" data-autom="bagrs-summary-subtotalvalue">$19.00</div>`;

function quantitySelect(document: Document): HTMLSelectElement {
  const select = document.querySelector('select[data-autom="item-quantity-dropdown"]');
  assert.equal(select?.tagName, "SELECT");
  return select as HTMLSelectElement;
}

function page(body: string, title = "Bag - Apple"): Document {
  return new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body><h1>Bag</h1>${body}</body></html>`).window
    .document;
}

describe("Apple bag DOM", () => {
  it("reads the live line item, not the bag heading or the 10+ option label", () => {
    const document = page(`${CABLE_ROW}${TOTALS}`);
    const bag = readPageBag(document);
    const item = bag.items[0];
    const select = quantitySelect(document);
    assert.ok(item);
    assert.equal(item.name, "60W USB-C Charge Cable (1 m)");
    assert.equal(item.quantity, 1);
    assert.equal(item.linePriceCents, 1_900);
    assert.equal(((item.linePriceCents ?? 0) / 100).toFixed(2), "19.00");
    assert.equal(bag.subtotalCents, 1_900);
    assert.equal(bag.totalCents, 2_100);
    assert.deepEqual(bag.itemNames, ["60W USB-C Charge Cable (1 m)"]);
    assert.equal(
      bag.itemNames.some((name) => name.toLowerCase() === "bag"),
      false,
    );
    assert.equal(select.options[select.options.length - 1]?.text, "10+");
    assert.equal(select.value, "1");
    assert.equal(item.quantity, Number(select.value));
    assert.equal(quantityTotalLabel(item.quantity ?? 0, bag.totalCents ?? 0), "1 · $21");

    select.value = "10";
    const reread = readPageBag(document);
    assert.equal(select.options[select.selectedIndex]?.text, "10+");
    assert.equal(reread.items[0]?.quantity, 10);
    assert.equal(reread.items[0]?.quantity, Number(select.value));
    assert.notEqual(String(reread.items[0]?.quantity), "10+");
  });

  it("does not invent a bag name when no line item is on the page", () => {
    const document = page("<p>10+</p><p>Subtotal</p><p>$19.00</p><p>Total</p><p>$21.00</p>");
    const bag = readPageBag(document);
    assert.equal(bag.parsed, false);
    assert.deepEqual(bag.items, []);
    assert.deepEqual(bag.itemNames, []);
    assert.equal(
      bag.itemNames.some((name) => /\bbag\b/i.test(name) || name === "10+"),
      false,
    );
  });

  it("prefers data-autom and falls back to row classes without the hidden quantity select", () => {
    const agreed = page(`<li class="rs-bag-item" data-autom="bag-item-2"><h2 class="rs-iteminfo-title"><a>Bag</a></h2><a data-autom="bag-item-name">60W USB-C Charge Cable (1\u00a0m)</a><select class="rs-quantity-hidden-select" aria-hidden="true"><option value="4">4</option></select><select data-autom="item-quantity-dropdown" class="rs-quantity-dropdown"><option value="1">1</option><option value="10">10+</option></select><div data-autom="Monthly_price"><p>$19.00</p></div></li>${TOTALS}`);
    const preferred = readPageBag(agreed);
    assert.equal(preferred.items[0]?.name, "60W USB-C Charge Cable (1 m)");
    assert.equal(preferred.items[0]?.quantity, 1);
    assert.equal(preferred.items[0]?.position, 2);

    const classesOnly = page(
      `<li class="rs-bag-item"><h2 class="rs-iteminfo-title"><a>60W USB-C Charge Cable (1 m)</a></h2><select aria-hidden="true" class="rs-quantity-hidden-select"><option value="4">4</option></select><select class="rs-quantity-dropdown"><option value="1">1</option><option value="10">10+</option></select><div class="rs-iteminfo-price"><p>$19.00</p></div></li>`,
    );
    const fallback = readPageBag(classesOnly);
    assert.equal(fallback.items[0]?.name, "60W USB-C Charge Cable (1 m)");
    assert.equal(fallback.items[0]?.quantity, 1);
    assert.equal(fallback.items[0]?.linePriceCents, 1_900);
    assert.equal(fallback.totalCents, 1_900);
  });
});

describe("apple.com cable row fixture", () => {
  it("parses the product name, quantity, and bag total", () => {
    const document = page(readFileSync(CABLE_FIXTURE, "utf8"));
    const bag = readPageBag(document);
    const item = bag.items[0];
    assert.ok(item);
    assert.equal(item.name, "60W USB-C Charge Cable (1 m)");
    assert.equal(item.quantity, 2);
    assert.equal(bag.quantity, 2);
    assert.equal(bag.totalCents, 4_201);
    assert.equal(bag.subtotalCents, 3_800);
    assert.equal(bag.parsed, true);
    assert.deepEqual(bag.itemNames, ["60W USB-C Charge Cable (1 m)"]);
    assert.equal(quantityTotalLabel(bag.quantity ?? 0, bag.totalCents ?? 0), "2 · $42.01");
    assert.equal(quantitySelect(document).value, "2");
  });

  it("re-reads an in-place quantity change and posts that bag once", () => {
    const document = page(readFileSync(CABLE_FIXTURE, "utf8"));
    const posted = readPageBag(document);
    const postedKey = bagContentKey(posted);
    assert.equal(postedKey, "2|4201|60W USB-C Charge Cable (1 m)");
    assert.equal(bagReadAction(postedKey, posted), "keep");

    const select = quantitySelect(document);
    select.value = "1";
    const total = document.querySelector('[data-autom="bagtotalvalue"]');
    const subtotal = document.querySelector('[data-autom="bagrs-summary-subtotalvalue"]');
    const line = document.querySelector('[data-autom="Monthly_price"] p');
    assert.ok(total);
    assert.ok(subtotal);
    assert.ok(line);
    total.textContent = "$21.00";
    subtotal.textContent = "$19.00";
    line.textContent = "$19.00";

    const reread = readPageBag(document);
    const hidden = document.querySelector("select.rs-quantity-hidden-select");
    assert.equal(hidden?.textContent?.trim(), "2");
    assert.equal(reread.items[0]?.name, "60W USB-C Charge Cable (1 m)");
    assert.equal(reread.quantity, 1);
    assert.equal(reread.items[0]?.quantity, 1);
    assert.equal(reread.totalCents, 2_100);
    assert.equal(quantityTotalLabel(reread.quantity ?? 0, reread.totalCents ?? 0), "1 · $21");
    assert.equal(bagReadAction(postedKey, reread), "post");
    assert.equal(bagReadAction(bagContentKey(reread), reread), "keep");
    assert.equal(bagReadAction(null, reread), "post");
  });
});
