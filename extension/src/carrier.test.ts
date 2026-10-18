import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { CARRIER_PASS, CARRIER_WAIT } from "../../src/scoring/carrierSwitch.js";
import { applePage, isFallbackBag, isLocalAmazonFixture, isLocalCarrierFixture, shouldEngage } from "../../src/sites.js";
import { buttonsToBlock } from "./overlay/block.js";
import { readActiveBag } from "./store-bag.js";
import { adapterFor } from "./stores/index.js";
import { amazonAdapter } from "./stores/amazon.js";
import { appleAdapter } from "./stores/apple.js";
import { CARRIER_ITEM_NAME, carrierAdapter, parseCarrierCents, readCarrierFacts } from "./stores/carrier.js";

const FIXTURE = new URL("../../web/carrier-switch.html", import.meta.url);

describe("carrier store adapter", () => {
  it("parses currency strings into integer cents", () => {
    assert.equal(parseCarrierCents("$80.00"), 8000);
    assert.equal(parseCarrierCents("$1,200.00"), 120000);
    assert.equal(parseCarrierCents("$0.00"), 0);
    assert.equal(parseCarrierCents("Balance\u00a0$360.00"), 36000);
    assert.equal(parseCarrierCents("free"), null);
    assert.equal(parseCarrierCents(""), null);
    assert.equal(parseCarrierCents("-$5.00"), null);
  });

  it("matches only the local fixture", () => {
    assert.equal(carrierAdapter.id, "carrier");
    assert.equal(carrierAdapter.match(locationAt("http://127.0.0.1:4321/carrier-switch")), true);
    assert.equal(carrierAdapter.match(locationAt("http://127.0.0.1:4321/carrier-switch?case=wait")), true);
    assert.equal(carrierAdapter.match(locationAt("http://localhost:4321/carrier-switch/?case=pass")), true);
    assert.equal(carrierAdapter.match(locationAt("https://www.verizon.com/switch")), false);
    assert.equal(carrierAdapter.match(locationAt("https://www.t-mobile.com/")), false);
    assert.equal(carrierAdapter.match(locationAt("http://127.0.0.1:4321/amazon")), false);
    assert.equal(carrierAdapter.match(locationAt("http://127.0.0.1:4321/fallback")), false);
    assert.equal(carrierAdapter.match(locationAt("https://www.apple.com/shop/bag")), false);
    assert.equal(amazonAdapter.match(locationAt("http://127.0.0.1:4321/carrier-switch")), false);
    assert.equal(appleAdapter.match(locationAt("http://127.0.0.1:4321/carrier-switch?case=pass")), false);
    assert.equal(adapterFor(locationAt("http://127.0.0.1:4321/carrier-switch?case=wait"))?.id, "carrier");
    assert.equal(adapterFor(locationAt("http://127.0.0.1:4321/amazon"))?.id, "amazon");
    assert.equal(adapterFor(locationAt("https://www.apple.com/shop/bag"))?.id, "apple");
    assert.equal(isLocalCarrierFixture("http://127.0.0.1:4321/carrier-switch?case=pass"), true);
    assert.equal(isLocalCarrierFixture("https://www.verizon.com/switch"), false);
    assert.equal(isLocalAmazonFixture("http://127.0.0.1:4321/carrier-switch"), false);
    assert.equal(isFallbackBag("http://127.0.0.1:4321/carrier-switch"), true);
    assert.equal(applePage("http://127.0.0.1:4321/carrier-switch"), null);
    assert.equal(shouldEngage("http://127.0.0.1:4321/carrier-switch", []), false);
  });

  it("reads the wait fixture, including the default HTML before the page script", () => {
    const html = readFileSync(FIXTURE, "utf8");
    assert.match(html, /Example data/);
    assert.doesNotMatch(html, /verizon\.com|t-mobile\.com|tmobile\.com/i);
    const doc = new JSDOM(html, { url: "http://127.0.0.1:4321/carrier-switch?case=wait" }).window.document;
    assert.deepEqual(readCarrierFacts(doc), CARRIER_WAIT);
    assert.deepEqual(carrierAdapter.readBag(doc), {
      items: [{ item: CARRIER_ITEM_NAME, price: CARRIER_WAIT.newMonthlyCents, category: "plan" }],
      total: CARRIER_WAIT.newMonthlyCents,
      carrier: CARRIER_WAIT,
    });
    const page = readActiveBag(carrierAdapter, doc);
    assert.equal(page.parsed, true);
    assert.deepEqual(page.itemNames, [CARRIER_ITEM_NAME]);
    assert.equal(page.totalCents, 7_400);
    assert.equal(carrierAdapter.isOrderConfirmation(doc), false);
    assert.deepEqual(
      carrierAdapter.checkoutButtons(doc).map((button) => button.id),
      ["switch"],
    );
    assert.deepEqual(
      buttonsToBlock(carrierAdapter, doc).map((button) => button.id),
      ["switch"],
    );
  });

  it("reads the pass variant after the page script fills the query", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const cases = JSON.parse(html.match(/<script type="application\/json" id="carrier-cases">([\s\S]*?)<\/script>/)?.[1] ?? "") as {
      wait: typeof CARRIER_WAIT;
      pass: typeof CARRIER_PASS;
    };
    assert.deepEqual(cases.wait, CARRIER_WAIT);
    assert.deepEqual(cases.pass, CARRIER_PASS);
    const doc = new JSDOM(html, {
      url: "http://127.0.0.1:4321/carrier-switch?case=pass",
      runScripts: "dangerously",
    }).window.document;
    assert.equal(doc.querySelector("#carrier-plan")?.getAttribute("data-case"), "pass");
    assert.deepEqual(readCarrierFacts(doc), CARRIER_PASS);
    assert.equal(carrierAdapter.readBag(doc)?.total, CARRIER_PASS.newMonthlyCents);
    assert.equal(carrierAdapter.readBag(doc)?.carrier?.balanceCents, 0);
    assert.equal(carrierAdapter.readBag(doc)?.carrier?.feeCents, 0);
  });

  it("exposes Switch and Confirm, and leaves a broken page unread", () => {
    const doc = new JSDOM(
      `<body>
        <button id="confirm" type="button">Confirm</button>
        <input id="switch-input" type="button" value="Switch" />
        <nav><button id="nav-switch" type="button">Switch</button></nav>
        <footer><button id="foot" type="button">Confirm</button></footer>
      </body>`,
      { url: "http://127.0.0.1:4321/carrier-switch" },
    ).window.document;
    assert.deepEqual(
      carrierAdapter.checkoutButtons(doc).map((button) => button.id),
      ["confirm", "switch-input"],
    );
    assert.equal(carrierAdapter.readBag(doc), null);
  });
});

function locationAt(href: string): Location {
  return new JSDOM("", { url: href }).window.location;
}
