import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { JSDOM } from "jsdom";

const stored: Record<string, unknown> = {
  simmerOrigin: "http://127.0.0.1:4321",
  simmerAuthOrigin: "http://127.0.0.1:4321",
  simmerUserId: "user-device-a",
  simmer_token: "token-a",
};

const cartA = bag("AAAAAA", "A phone", "account-a", "2026-10-18T00:00:00.000Z");
const cartB = bag("AAAAAA", "B cable", "account-b", "2026-10-18T02:00:00.000Z");

describe("popup vault account scope", () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <h1 id="state">Marinating</h1>
    <ul id="list"></ul>
    <p id="empty" hidden>No bag yet. Open a checkout page.</p>
  </body></html>`);
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousChrome = (globalThis as { chrome?: typeof chrome }).chrome;

  afterEach(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    (globalThis as { chrome?: typeof chrome }).chrome = previousChrome;
  });

  it("clears the previous account on sign-out and shows only the next account", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    const cartAuth: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization") ?? "";
      if (url.endsWith("/auth/me")) {
        if (authorization === "Bearer token-a") {
          return json({ user: { id: "account-a", email: "a@example.com" } });
        }
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/logout")) {
        return json({ ok: true });
      }
      if (url.endsWith("/auth/login")) {
        return json({ user: { id: "account-b", email: "b@example.com" }, token: "token-b" });
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: false, hourlyRate: null, weeklyBudget: null });
      }
      if (url.endsWith("/api/carts")) {
        cartAuth.push(authorization);
        return json({ carts: [cartA, cartB] });
      }
      return json({ error: "missing" }, 404);
    }) as typeof fetch;

    await import("./popup.js");
    await waitFor(() => listText().includes("A phone"));
    assert.equal(listText().includes("B cable"), false);
    assert.equal(cartAuth[0], "Bearer token-a");
    assert.equal(document.getElementById("empty")?.hidden, true);

    const card = document.querySelector<HTMLButtonElement>("#list button.card");
    assert.ok(card);
    card.click();
    assert.equal(card.getAttribute("aria-expanded"), "true");

    clickButton("Sign out");
    await waitFor(() => document.getElementById("empty")?.hidden === false && listText().length === 0);
    assert.equal(listText().includes("A phone"), false);
    assert.equal(document.querySelector("#list button"), null);
    assert.equal(stored.simmerUserId, "user-device-a");

    const email = document.querySelector<HTMLInputElement>("input[name='email']");
    const password = document.querySelector<HTMLInputElement>("input[name='password']");
    assert.ok(email && password);
    email.value = "b@example.com";
    password.value = "correct horse battery";
    clickButton("Sign in");
    await waitFor(() => listText().includes("B cable"));
    assert.equal(listText().includes("A phone"), false);
    assert.equal(cartAuth.at(-1), "Bearer token-b");
    const next = document.querySelector<HTMLButtonElement>("#list button.card");
    assert.ok(next);
    assert.equal(next.getAttribute("aria-expanded"), "false");
    next.click();
    assert.equal(next.getAttribute("aria-expanded"), "true");
    assert.equal(stored.simmerUserId, "user-device-a");
  });
});

function bag(code: string, name: string, authUserId: string, createdAt: string) {
  return {
    code,
    userId: "user-device-a",
    authUserId,
    createdAt,
    status: "locked" as const,
    totalCents: 119_900,
    vaultUntil: null,
    items: [{ name }],
    decision: null,
    signals: {},
    motiveSources: null,
  };
}

function listText(): string {
  return document.getElementById("list")?.textContent ?? "";
}

function clickButton(text: string): void {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  assert.ok(button);
  button.click();
}

function installChrome(): void {
  (globalThis as { chrome?: typeof chrome }).chrome = {
    runtime: { sendMessage: () => undefined },
    storage: {
      local: {
        get: (_keys, callback) => {
          callback({ ...stored });
        },
        set: (items, callback) => {
          Object.assign(stored, items);
          callback?.();
        },
      },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 2_000) {
      throw new Error(`Timed out waiting for the popup vault. List: ${listText()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
