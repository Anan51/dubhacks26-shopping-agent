import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const popupHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../popup.html"), "utf8");
const REPLY_NOTE = "Reply to Simmer's iMessage to unlock. Simmer will not click Apple's button.";

const stored: Record<string, unknown> = {
  simmerOrigin: "http://127.0.0.1:4321",
  simmerAuthOrigin: "http://127.0.0.1:4321",
  simmerUserId: "device-user",
  simmer_token: "",
};

describe("popup status note", () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousChrome = (globalThis as { chrome?: typeof chrome }).chrome;

  afterEach(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    (globalThis as { chrome?: typeof chrome }).chrome = previousChrome;
  });

  it("is hidden in the popup markup before render", () => {
    const dom = new JSDOM(popupHtml, { url: "http://127.0.0.1:4321/" });
    const note = dom.window.document.getElementById("status-note");
    assert.ok(note);
    assert.equal(note.hidden, true);
    assert.equal(note.textContent, REPLY_NOTE);
    assert.equal(displayOf(note), "none");
  });

  it("stays hidden with no bag, shows for a locked bag, and hides again when the bag clears", async () => {
    const dom = new JSDOM(popupHtml, { url: "http://127.0.0.1:4321/" });
    globalThis.document = dom.window.document;
    const note = document.getElementById("status-note");
    const empty = document.getElementById("empty");
    assert.ok(note);
    assert.ok(empty);
    assert.equal(note.hidden, true);
    assert.equal(displayOf(note), "none");

    installChrome();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization") ?? "";
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/login")) {
        return json({ user: { id: "account-1", email: "ada@example.com" }, token: "jwt-1" });
      }
      if (url.endsWith("/auth/logout")) {
        return json({ ok: true });
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: true, hourlyRate: 42, weeklyBudget: 150 });
      }
      if (url.includes("/purchases/history")) {
        return json({ purchases: [] });
      }
      if (url.endsWith("/api/carts")) {
        if (authorization === "Bearer jwt-1") {
          return json({ carts: [lockedBag] });
        }
        return json({ carts: [] });
      }
      return json({ error: "missing" }, 404);
    }) as typeof fetch;

    await import("./popup.js");
    await waitFor(() => empty.hidden === false && (document.getElementById("list")?.textContent ?? "") === "");
    assert.equal(empty.textContent, "No bag yet. Open a checkout page.");
    assert.equal(note.hidden, true);
    assert.equal(displayOf(note), "none");

    const email = document.querySelector<HTMLInputElement>("input[name='email']");
    const password = document.querySelector<HTMLInputElement>("input[name='password']");
    assert.ok(email && password);
    email.value = "ada@example.com";
    password.value = "correct horse battery";
    clickButton("Sign in");
    await waitFor(() => listText().includes("USB-C cable"));
    assert.equal(empty.hidden, true);
    assert.equal(note.hidden, false);
    assert.equal(displayOf(note), "block");
    assert.equal(note.textContent, REPLY_NOTE);

    clickButton("Sign out");
    await waitFor(() => empty.hidden === false && listText() === "");
    assert.equal(empty.textContent, "No bag yet. Open a checkout page.");
    assert.equal(note.hidden, true);
    assert.equal(displayOf(note), "none");
  });
});

const lockedBag = {
  code: "CABLE1",
  userId: "device-user",
  authUserId: "account-1",
  createdAt: "2026-10-18T03:00:00.000Z",
  status: "locked" as const,
  totalCents: 1900,
  vaultUntil: null,
  items: [{ name: "USB-C cable" }],
  decision: null,
  signals: {},
  motiveSources: null,
};

function listText(): string {
  return document.getElementById("list")?.textContent ?? "";
}

function displayOf(element: Element): string {
  const view = element.ownerDocument.defaultView;
  assert.ok(view);
  return view.getComputedStyle(element).display;
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
      throw new Error(`Timed out waiting for the popup status note. List: ${listText()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
