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
        isExample: false,
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
        source: "survey",
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

  it("clears the session when a rating is rejected", async () => {
    globalThis.document = dom.window.document;
    let votes = 0;
    let cleared = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        votes += 1;
        return new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 });
      }
      return new Response(
        JSON.stringify({
          purchases: [
            {
              _id: "64b000000000000000000009",
              item: "Phone",
              category: "phone",
              price: 10,
              feedback: null,
              isExample: false,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321", async () => "jwt", async () => {
      cleared = true;
    }).show();
    await waitFor(() => document.body.textContent?.includes("Phone") === true);
    const down = document.querySelector("button[aria-label='Thumbs down']");
    assert.ok(down instanceof dom.window.HTMLButtonElement);
    down.click();
    await waitFor(() => cleared && votes === 1);
    assert.equal(document.body.textContent?.includes("Could not save that rating."), false);
  });

  it("keeps a slow history response from replacing a newer list", async () => {
    globalThis.document = dom.window.document;
    let calls = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      calls += 1;
      const which = calls;
      if (which === 1) {
        await gate;
      }
      const item = which === 1 ? "Stale cable" : "Fresh phone";
      return new Response(
        JSON.stringify({
          purchases: [{ _id: `64b00000000000000000000${which}`, item, category: "other", price: 1, feedback: null, isExample: false }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    const history = attachPurchaseHistory(parent, "http://127.0.0.1:4321");
    history.show();
    history.show();
    await waitFor(() => document.body.textContent?.includes("Fresh phone") === true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.body.textContent?.includes("Stale cable"), false);
    assert.equal(document.body.textContent?.includes("Fresh phone"), true);
  });

  it("asks before removing a purchase and leaves the row when declined", async () => {
    globalThis.document = dom.window.document;
    const methods: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return historyResponse([purchase("64b000000000000000000011", "AirPods")]);
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321").show();
    await waitFor(() => document.body.textContent?.includes("AirPods") === true);
    const remove = removeButton();
    assert.ok(remove);
    assert.equal(remove.closest("li")?.contains(remove), true);
    assert.match(document.querySelector("style")?.textContent ?? "", /flex-wrap:\s*wrap/);
    remove.click();
    assert.match(document.body.textContent ?? "", /Remove this purchase\?/);
    const no = confirmButton("No");
    assert.ok(no);
    no.click();
    assert.equal(document.body.textContent?.includes("Remove this purchase?"), false);
    assert.equal(methods.includes("DELETE"), false);
    assert.match(document.body.textContent ?? "", /AirPods/);
  });

  it("removes the row after Yes and sends the auth token", async () => {
    globalThis.document = dom.window.document;
    let authorization: string | null = null;
    let deleted = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        authorization = new Headers(init.headers).get("authorization");
        deleted = String(input);
        return new Response(null, { status: 204 });
      }
      return historyResponse([purchase("64b000000000000000000012", "Phone")]);
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321", async () => "jwt-remove").show();
    await waitFor(() => document.body.textContent?.includes("Phone") === true);
    removeButton()?.click();
    confirmButton("Yes")?.click();
    await waitFor(() => document.querySelector("#simmer-purchases li") === null);
    assert.equal(document.body.textContent?.includes("Phone"), false);
    assert.equal(document.querySelector("#simmer-purchases .fine")?.hasAttribute("hidden"), false);
    assert.equal(deleted, "http://127.0.0.1:4321/purchases/64b000000000000000000012");
    assert.equal(authorization, "Bearer jwt-remove");
  });

  it("keeps the row and shows an inline error when remove fails", async () => {
    globalThis.document = dom.window.document;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Purchase request failed." }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return historyResponse([purchase("64b000000000000000000013", "Watch")]);
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321", async () => "jwt-remove").show();
    await waitFor(() => document.body.textContent?.includes("Watch") === true);
    removeButton()?.click();
    confirmButton("Yes")?.click();
    await waitFor(() => document.body.textContent?.includes("Could not remove that purchase.") === true);
    const row = document.querySelector("#simmer-purchases li");
    assert.ok(row);
    assert.match(row.textContent ?? "", /Watch/);
    assert.match(row.textContent ?? "", /Could not remove that purchase\./);
  });

  it("disables Remove, Yes, and No while that delete is in flight", async () => {
    globalThis.document = dom.window.document;
    let releaseDelete = (): void => undefined;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        await deleteGate;
        return new Response(null, { status: 204 });
      }
      return historyResponse([purchase("64b000000000000000000041", "Watch")]);
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321", async () => "jwt-remove").show();
    await waitFor(() => document.body.textContent?.includes("Watch") === true);
    const row = rowContaining("Watch");
    assert.ok(row);
    const remove = buttonLabeled(row, "Remove");
    assert.ok(remove);
    assert.equal(remove.disabled, false);
    remove.click();
    const yes = buttonLabeled(row, "Yes");
    const no = buttonLabeled(row, "No");
    assert.ok(yes && no);
    assert.equal(yes.disabled, false);
    assert.equal(no.disabled, false);
    yes.click();
    assert.equal(remove.disabled, true);
    assert.equal(yes.disabled, true);
    assert.equal(no.disabled, true);
    releaseDelete();
    await waitFor(() => document.querySelector("#simmer-purchases li") === null);
  });

  it("removes both rows when two deletes are in flight", async () => {
    globalThis.document = dom.window.document;
    let started = 0;
    const releases: Array<() => void> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        started += 1;
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return new Response(null, { status: 204 });
      }
      return historyResponse([
        purchase("64b000000000000000000031", "Cable"),
        purchase("64b000000000000000000032", "Phone"),
      ]);
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321", async () => "jwt-remove").show();
    await waitFor(() => document.body.textContent?.includes("Cable") === true && document.body.textContent?.includes("Phone") === true);
    const cable = rowContaining("Cable");
    const phone = rowContaining("Phone");
    assert.ok(cable && phone);
    buttonLabeled(cable, "Remove")?.click();
    buttonLabeled(phone, "Remove")?.click();
    buttonLabeled(cable, "Yes")?.click();
    buttonLabeled(phone, "Yes")?.click();
    await waitFor(() => started === 2);
    assert.equal(buttonLabeled(cable, "Remove")?.disabled, true);
    assert.equal(buttonLabeled(cable, "Yes")?.disabled, true);
    assert.equal(buttonLabeled(phone, "Remove")?.disabled, true);
    assert.equal(buttonLabeled(phone, "Yes")?.disabled, true);
    for (const release of releases) {
      release();
    }
    await waitFor(() => document.querySelector("#simmer-purchases li") === null);
    assert.equal(document.body.textContent?.includes("Cable"), false);
    assert.equal(document.body.textContent?.includes("Phone"), false);
  });

  it("removes the row when a 204 arrives after a rating reloads the list", async () => {
    globalThis.document = dom.window.document;
    const phoneId = "64b000000000000000000051";
    let historyCalls = 0;
    let releaseDelete = (): void => undefined;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        await deleteGate;
        return new Response(null, { status: 204 });
      }
      if (init?.method === "POST") {
        return historyResponse([]);
      }
      historyCalls += 1;
      const feedback = historyCalls === 1 ? null : "regretted";
      return historyResponse([purchase(phoneId, "Phone", feedback)]);
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    attachPurchaseHistory(parent, "http://127.0.0.1:4321", async () => "jwt-remove").show();
    await waitFor(() => document.body.textContent?.includes("Phone") === true);
    const row = rowContaining("Phone");
    assert.ok(row);
    buttonLabeled(row, "Remove")?.click();
    buttonLabeled(row, "Yes")?.click();
    const down = document.querySelector("button[aria-label='Thumbs down']");
    assert.ok(down instanceof dom.window.HTMLButtonElement);
    down.click();
    await waitFor(() => document.querySelector("button[aria-label='Thumbs down']")?.getAttribute("aria-pressed") === "true");
    assert.match(document.body.textContent ?? "", /Phone/);
    releaseDelete();
    await waitFor(() => document.querySelector(`li[data-purchase-id='${phoneId}']`) === null);
    assert.equal(document.body.textContent?.includes("Phone"), false);
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

function purchase(
  id: string,
  item: string,
  feedback: "regretted" | "kept" | null = null,
): {
  _id: string;
  item: string;
  category: string;
  price: number;
  feedback: "regretted" | "kept" | null;
  isExample: false;
} {
  return { _id: id, item, category: "other", price: 19, feedback, isExample: false };
}

function historyResponse(purchases: unknown[]): Response {
  return new Response(JSON.stringify({ purchases }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function removeButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((button) => button.textContent === "Remove");
}

function rowContaining(item: string): HTMLLIElement | undefined {
  const row = [...document.querySelectorAll("#simmer-purchases li")].find((node) => node.textContent?.includes(item));
  if (!row || row.tagName !== "LI") {
    return undefined;
  }
  return row as HTMLLIElement;
}

function buttonLabeled(root: ParentNode, label: string): HTMLButtonElement | undefined {
  const button = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!button || button.tagName !== "BUTTON") {
    return undefined;
  }
  return button as HTMLButtonElement;
}

function confirmButton(label: "Yes" | "No"): HTMLButtonElement | undefined {
  const button = [...document.querySelectorAll(".confirm button")].find((node) => node.textContent === label);
  if (!button || button.tagName !== "BUTTON") {
    return undefined;
  }
  return button as HTMLButtonElement;
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 1000) {
      throw new Error("Timed out waiting for the purchase history popup.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
