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

  it("shows survey purchases, skips seeded examples, and can change a rating", async () => {
    globalThis.document = dom.window.document;
    let feedback: "regretted" | "kept" | null = "kept";
    const posted: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { feedback: "regretted" | "kept" | null };
        feedback = body.feedback;
        posted.push(body.feedback);
      }
      const survey = {
        _id: "64b000000000000000000001",
        userId: "64b0000000000000000000aa",
        item: "AirPods",
        category: "audio",
        price: 179,
        verdict: null,
        feedback,
        isExample: true,
        source: "survey",
        createdAt: "2026-10-18T00:00:00.000Z",
        ratedAt: feedback ? "2026-10-18T00:01:00.000Z" : null,
      };
      const seeded = {
        _id: "64b000000000000000000002",
        item: "Fake phone",
        category: "phone",
        price: 799,
        feedback: null,
        isExample: true,
        source: "checkout",
      };
      const payload = url.includes("/feedback") ? { purchase: survey } : { purchases: [seeded, survey] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const parent = document.createElement("div");
    document.body.append(parent);
    const history = attachPurchaseHistory(parent, "http://127.0.0.1:4321");
    history.show();
    await waitFor(() => document.body.textContent?.includes("AirPods") === true);

    const section = document.getElementById("simmer-purchases");
    assert.ok(section);
    assert.equal(section.textContent?.includes("Example data"), false);
    assert.equal(section.textContent?.includes("Fake phone"), false);
    assert.match(section.textContent ?? "", /AirPods/);
    const down = section.querySelector("button[aria-label='Thumbs down']");
    assert.ok(down instanceof dom.window.HTMLButtonElement);
    assert.equal(down.getAttribute("aria-pressed"), "false");
    down.click();
    await waitFor(() => posted.length === 1);
    assert.deepEqual(posted, ["regretted"]);
    await waitFor(() => section.querySelector("button[aria-label='Thumbs down']")?.getAttribute("aria-pressed") === "true");

    const up = section.querySelector("button[aria-label='Thumbs up']");
    assert.ok(up instanceof dom.window.HTMLButtonElement);
    up.click();
    await waitFor(() => posted.length === 2);
    assert.deepEqual(posted, ["regretted", "kept"]);
  });

  it("says there are no purchases yet when history is empty or only seeded", async () => {
    globalThis.document = dom.window.document;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          purchases: [{ _id: "64b000000000000000000003", item: "Fake cable", isExample: true, price: 19, category: "cable" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321").show();
    await waitFor(() => document.body.textContent?.includes("No purchases yet.") === true);
    assert.equal(document.body.textContent?.includes("Fake cable"), false);
  });

  it("clears the session when the history request is rejected", async () => {
    globalThis.document = dom.window.document;
    let cleared = false;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 })) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321", async () => "jwt", async () => {
      cleared = true;
    }).show();
    await waitFor(() => cleared);
    assert.equal(document.body.textContent?.includes("Could not load purchases."), false);
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
