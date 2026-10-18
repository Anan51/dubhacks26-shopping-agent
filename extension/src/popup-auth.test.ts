import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { mountPopupAuth } from "./popup-auth.js";

const HINT = "Set the Auth server URL in Options (http://127.0.0.1:<port>) to sign in.";
const BLOCKED = [undefined, null, "", "   ", "https://127.0.0.1:4321", "http://evil.example", "not a url"];

describe("popup auth", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousChrome = (globalThis as { chrome?: unknown }).chrome;

  afterEach(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    (globalThis as { chrome?: unknown }).chrome = previousChrome;
    dom.window.document.body.replaceChildren();
  });

  it("mounts sign-in and sign-out when the auth server is a local http URL", () => {
    globalThis.document = dom.window.document;
    installChrome();
    globalThis.fetch = (async () => json({ error: "Authentication required." }, 401)) as typeof fetch;

    const parent = document.createElement("div");
    document.body.append(parent);
    assert.equal(mountPopupAuth(parent, "http://127.0.0.1:4321"), true);

    assert.ok(document.getElementById("simmer-auth"));
    assert.equal(document.getElementById("simmer-auth-hint"), null);
    assert.equal(buttonText("Sign in"), true);
    assert.equal(buttonText("Sign out"), true);
    assert.equal(document.body.textContent?.includes(HINT), false);
  });

  it("shows an Options hint when the auth server is missing or not a local http URL", () => {
    globalThis.document = dom.window.document;
    const opened = { count: 0 };
    installChrome(() => {
      opened.count += 1;
    });

    for (const origin of BLOCKED) {
      const parent = document.createElement("div");
      document.body.append(parent);
      assert.equal(mountPopupAuth(parent, origin), false);
      const hint = parent.querySelector("#simmer-auth-hint");
      assert.ok(hint);
      assert.equal(hint.textContent?.includes(HINT), true);
      assert.equal(parent.querySelector("#simmer-auth"), null);
      assert.equal(buttonText("Sign in"), false);
      assert.equal(buttonText("Sign out"), false);
      const options = [...parent.querySelectorAll("button")].find((button) => button.textContent === "Options");
      assert.ok(options);
      options.click();
      parent.remove();
    }
    assert.equal(opened.count, BLOCKED.length);
  });

  it("leaves the hint usable when Options cannot be opened", () => {
    globalThis.document = dom.window.document;
    installChrome();

    const parent = document.createElement("div");
    document.body.append(parent);
    assert.equal(mountPopupAuth(parent, undefined), false);
    const options = [...parent.querySelectorAll("button")].find((button) => button.textContent === "Options");
    assert.ok(options);
    assert.doesNotThrow(() => {
      options.click();
    });
    assert.equal(parent.querySelector("#simmer-auth"), null);
  });
});

function buttonText(text: string): boolean {
  return [...document.querySelectorAll("button")].some((button) => button.textContent === text);
}

function installChrome(openOptionsPage?: () => void): void {
  const runtime: { sendMessage: () => undefined; openOptionsPage?: () => void } = {
    sendMessage: () => undefined,
  };
  if (openOptionsPage) {
    runtime.openOptionsPage = openOptionsPage;
  }
  (globalThis as { chrome?: unknown }).chrome = {
    runtime,
    storage: {
      local: {
        get: (_keys: string[] | null, callback: (items: Record<string, unknown>) => void) => {
          callback({});
        },
        set: (_items: Record<string, unknown>, callback?: () => void) => {
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
