import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { mountPopupAuth } from "./popup-auth.js";

describe("popup survey", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousChrome = (globalThis as { chrome?: typeof chrome }).chrome;
  const stored: Record<string, unknown> = {};

  afterEach(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    (globalThis as { chrome?: typeof chrome }).chrome = previousChrome;
    dom.window.document.body.replaceChildren();
    for (const key of Object.keys(stored)) {
      delete stored[key];
    }
  });

  it("stores the signup token and shows the survey before purchase history", async () => {
    globalThis.document = dom.window.document;
    (globalThis as { chrome?: typeof chrome }).chrome = {
      runtime: {
        sendMessage: () => undefined,
      },
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
    const posted: { url: string; body: unknown; authorization: string | null }[] = [];
    let surveyCompleted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization");
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)), authorization });
      }
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/onboarding/survey") && init?.method !== "POST") {
        return json(
          surveyCompleted
            ? { completed: true, hourlyRate: 42, weeklyBudget: 150 }
            : { completed: false, hourlyRate: null, weeklyBudget: null },
        );
      }
      if (url.endsWith("/onboarding/survey")) {
        surveyCompleted = true;
        return json({ completed: true, hourlyRate: 42, weeklyBudget: 150, purchases: [] }, 201);
      }
      if (url.includes("/purchases/history")) {
        return json({
          purchases: [
            {
              _id: "64b000000000000000000001",
              item: "AirPods",
              category: "audio",
              price: 179,
              feedback: "regretted",
              isExample: false,
            },
          ],
        });
      }
      return json({ error: "missing" }, 404);
    }) as typeof fetch;

    const parent = document.createElement("div");
    document.body.append(parent);
    assert.equal(mountPopupAuth(parent, "http://127.0.0.1:4321"), true);
    await waitFor(() => document.querySelector("#simmer-auth form") instanceof dom.window.HTMLFormElement);

    const email = document.querySelector<HTMLInputElement>("input[name='email']");
    const password = document.querySelector<HTMLInputElement>("input[name='password']");
    assert.ok(email && password);
    email.value = "ada@example.com";
    password.value = "correct horse battery";
    document.querySelectorAll("button")[0]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => document.getElementById("simmer-survey")?.hidden === false);
    assert.equal(stored.simmer_token, "jwt-from-signup");
    assert.equal(document.getElementById("simmer-purchases")?.hidden, true);

    const hourly = document.querySelector<HTMLInputElement>("input[name='hourlyRate']");
    const weekly = document.querySelector<HTMLInputElement>("input[name='weeklyBudget']");
    assert.ok(hourly && weekly);
    hourly.value = "42";
    weekly.value = "150";
    const add = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add a recent purchase");
    assert.ok(add);
    add.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const item = document.querySelector<HTMLInputElement>("input[aria-label='Recent purchase item']");
    const price = document.querySelector<HTMLInputElement>("input[aria-label='Recent purchase price']");
    const regretted = document.querySelector<HTMLInputElement>("#simmer-survey input[type='checkbox']");
    assert.ok(item && price && regretted);
    item.value = "AirPods";
    price.value = "179";
    regretted.checked = true;
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save survey");
    assert.ok(save);
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => document.body.textContent?.includes("AirPods") === true);

    const surveyPost = posted.find((call) => call.url.endsWith("/onboarding/survey"));
    assert.ok(surveyPost);
    assert.equal(surveyPost.authorization, "Bearer jwt-from-signup");
    assert.deepEqual(surveyPost.body, {
      hourlyRate: 42,
      weeklyBudget: 150,
      recentPurchases: [{ item: "AirPods", price: 179, regretted: true }],
    });
    assert.equal(document.getElementById("simmer-survey")?.hidden, true);
    assert.equal(document.getElementById("simmer-purchases")?.hidden, false);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 1000) {
      throw new Error("Timed out waiting for the popup survey.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
