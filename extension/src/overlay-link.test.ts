import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { linkCodeForUser } from "../../src/links.js";
import { mountOverlay, type OverlayModel } from "./overlay.js";

(globalThis as { React?: typeof React }).React = React;

const SHOPPER = "user-2557c60f-1111-4111-8111-111111111111";
const PLACEHOLDER_NUMBER = "+15550001111";

describe("paused card link copy", () => {
  it("shows the short code and the agent number", async () => {
    const code = linkCodeForUser(SHOPPER);
    const view = render({
      linkMessage: `link ${code}`,
      agentHandle: PLACEHOLDER_NUMBER,
      pingDelivered: false,
      pingReason: "unlinked",
    });
    await flush();
    const text = view.text();
    view.close();
    assert.equal(text.includes(`Text link ${code} to ${PLACEHOLDER_NUMBER}.`), true);
    assert.equal(text.includes(SHOPPER), false);
    assert.equal(text.includes("iMessage number"), false);
  });

  it("omits the number and the raw user id when the handle is unset", async () => {
    const code = linkCodeForUser(SHOPPER);
    const view = render({
      linkMessage: `link ${code}`,
      agentHandle: null,
      pingDelivered: false,
      pingReason: "unlinked",
    });
    await flush();
    const text = view.text();
    view.close();
    assert.equal(text.includes(`Text link ${code} to Simmer on iMessage.`), true);
    assert.equal(text.includes(SHOPPER), false);
    assert.equal(text.includes(PLACEHOLDER_NUMBER), false);
  });

  it("does not print a raw user id when that is all the server sent", async () => {
    const view = render({
      linkMessage: `link ${SHOPPER}`,
      agentHandle: null,
      pingDelivered: false,
      pingReason: "unlinked",
    });
    await flush();
    const text = view.text();
    view.close();
    assert.equal(text.includes("Text Simmer on iMessage to link this checkout."), true);
    assert.equal(text.includes("user-"), false);
  });
});

function render(overrides: Partial<OverlayModel>): { text: () => string; close: () => void } {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://www.apple.com/shop/bag" });
  const view = dom.window;
  view.setInterval = (() => 0) as typeof view.setInterval;
  const previous = {
    document: (globalThis as { document?: Document }).document,
    window: (globalThis as { window?: Window }).window,
  };
  (globalThis as { document?: Document }).document = view.document;
  (globalThis as { window?: Window }).window = view as unknown as Window;
  const host = view.document.createElement("div");
  view.document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  mountOverlay(shadow, card(overrides), { unlock() {}, sleep() {} });
  return {
    text: () => shadow.textContent ?? "",
    close() {
      (globalThis as { document?: Document }).document = previous.document;
      (globalThis as { window?: Window }).window = previous.window;
    },
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function card(overrides: Partial<OverlayModel>): OverlayModel {
  return {
    code: "BAG123",
    status: "locked",
    isUnlocked: false,
    lockEndsAt: new Date(Date.now() + 60_000).toISOString(),
    vaultUntil: null,
    totalCents: 120_000,
    parsedFromPage: true,
    itemNames: ["Example phone"],
    quantity: 1,
    explanation: null,
    decision: null,
    signals: {},
    motiveSources: null,
    reading: false,
    userId: SHOPPER,
    linkMessage: null,
    agentHandle: null,
    fallbackPage: false,
    replied: false,
    advice: null,
    pingDelivered: false,
    pingReason: "unlinked",
    smsLink: null,
    qrDataUrl: null,
    turns: [],
    error: null,
    necessity: "unnecessary",
    necessitySource: null,
    necessityReason: null,
    userImpulseScore: null,
    justificationGrade: null,
    gradeSource: null,
    gradeReason: null,
    purchaseScore: null,
    scoreBucket: "soft",
    scoreReason: null,
    ...overrides,
  };
}
