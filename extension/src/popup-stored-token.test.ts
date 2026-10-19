import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { JSDOM } from "jsdom";

const stored: Record<string, unknown> = {
  simmerOrigin: "http://127.0.0.1:4321",
  simmerAuthOrigin: "http://127.0.0.1:4321",
  simmerUserId: "device-user",
  simmer_token: "",
};

describe("popup stored token", () => {
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

  it("clears a stored token when /auth/me returns 401 and shows the device list", async () => {
    stored.simmer_token = "stale-token";
    const calls: { url: string; authorization: string }[] = [];
    install(dom, (url, authorization) => {
      calls.push({ url, authorization });
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/api/carts")) {
        return json({ carts: [deviceCart, accountCart] });
      }
      return json({ error: "missing" }, 404);
    });

    await import("./popup.js");
    await waitFor(() => listText().includes("Device lamp"));

    assert.equal(stored.simmer_token, "");
    assert.equal(listText().includes("Account mug"), false);
    assert.equal(document.getElementById("empty")?.hidden, true);
    const form = document.querySelector("#simmer-auth form");
    const signed = document.querySelector("#simmer-auth .signed");
    assert.ok(form instanceof dom.window.HTMLFormElement);
    assert.equal(form.hidden, false);
    assert.ok(signed instanceof dom.window.HTMLElement);
    assert.equal(signed.hidden, true);
    assert.equal(calls.some((call) => call.url.endsWith("/auth/me") && call.authorization === "Bearer stale-token"), true);
    const carts = calls.find((call) => call.url.endsWith("/api/carts"));
    assert.ok(carts);
    assert.equal(carts.authorization, "");
  });
});

const deviceCart = bag("DEVICE", "Device lamp", "device-user", null, "2026-10-18T01:00:00.000Z");
const accountCart = bag("ACCOUNT", "Account mug", "other-device", "account-1", "2026-10-18T03:00:00.000Z");

function bag(code: string, name: string, userId: string, authUserId: string | null, createdAt: string) {
  return {
    code,
    userId,
    authUserId,
    createdAt,
    status: "locked" as const,
    totalCents: 2500,
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

function install(
  dom: JSDOM,
  respond: (url: string, authorization: string) => Response,
): void {
  globalThis.document = dom.window.document;
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    return respond(String(input), headers.get("authorization") ?? "");
  }) as typeof fetch;
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
      throw new Error(`Timed out waiting for the popup. List: ${listText()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
