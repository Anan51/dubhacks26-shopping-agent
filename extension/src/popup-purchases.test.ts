import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { attachPurchaseHistory } from "./popup-purchases.js";

describe("purchase history popup", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    dom.window.document.body.replaceChildren();
  });

  it("labels example data and posts a vote that can be cleared", async () => {
    globalThis.document = dom.window.document;
    let feedback: "regretted" | "kept" | null = null;
    const posted: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { feedback: "regretted" | "kept" | null };
        feedback = body.feedback;
        posted.push(body.feedback);
      }
      const row = {
        _id: "64b000000000000000000001",
        userId: "64b0000000000000000000aa",
        item: "AirPods",
        category: "audio",
        price: 179,
        verdict: "sleep",
        feedback,
        isExample: true,
        createdAt: "2026-10-18T00:00:00.000Z",
        ratedAt: feedback ? "2026-10-18T00:01:00.000Z" : null,
      };
      const payload = url.includes("/feedback") ? { purchase: row } : { purchases: [row] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const parent = document.createElement("div");
    document.body.append(parent);
    const history = attachPurchaseHistory(parent, "http://127.0.0.1:4321");
    history.show();
    await waitFor(() => document.body.textContent?.includes("Example data") === true);

    const section = document.getElementById("simmer-purchases");
    assert.ok(section);
    assert.match(section.textContent ?? "", /Example data/);
    assert.match(section.textContent ?? "", /AirPods/);
    const down = section.querySelector("button[aria-label='Thumbs down']");
    assert.ok(down instanceof dom.window.HTMLButtonElement);
    assert.equal(down.getAttribute("aria-pressed"), "false");
    down.click();
    await waitFor(() => posted.length === 1);
    assert.deepEqual(posted, ["regretted"]);
    await waitFor(() => section.querySelector("button[aria-label='Thumbs down']")?.getAttribute("aria-pressed") === "true");

    const pressed = section.querySelector("button[aria-label='Thumbs down']");
    assert.ok(pressed instanceof dom.window.HTMLButtonElement);
    pressed.click();
    await waitFor(() => posted.length === 2);
    assert.deepEqual(posted, ["regretted", null]);
    await waitFor(() => section.querySelector("button[aria-label='Thumbs down']")?.getAttribute("aria-pressed") === "false");
  });
});

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 1000) {
      throw new Error("Timed out waiting for the purchase history popup.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
