import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { JSDOM } from "jsdom";

import { mountPopupAuth } from "./popup-auth.js";

const stored: Record<string, unknown> = {};

describe("popup survey", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousChrome = (globalThis as { chrome?: typeof chrome }).chrome;

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
    installChrome();
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
    assert.equal([...document.querySelectorAll("button")].some((button) => button.textContent === "Past purchases"), true);
    assert.equal([...document.querySelectorAll("button")].some((button) => button.textContent === "Settings"), true);
  });

  it("sends the stored bearer on reopen and clears it when the session is rejected", async () => {
    globalThis.document = dom.window.document;
    stored.simmer_token = "stale-jwt";
    const seen: string[] = [];
    installChrome();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("authorization") ?? "");
      return json({ error: "Authentication required." }, 401);
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    mountPopupAuth(parent, "http://127.0.0.1:4321");
    await waitFor(() => stored.simmer_token === "");
    assert.equal(seen[0], "Bearer stale-jwt");
    const form = document.querySelector("#simmer-auth form");
    assert.ok(form instanceof dom.window.HTMLFormElement);
    assert.equal(form.hidden, false);
  });

  it("disables Save while the survey request is in flight", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/onboarding/survey") && init?.method === "POST") {
        await gate;
        return json({ completed: true, hourlyRate: 1, weeklyBudget: null, purchases: [] }, 201);
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: false, hourlyRate: null, weeklyBudget: null });
      }
      return json({ purchases: [] });
    }) as typeof fetch;
    const parent = document.createElement("div");
    document.body.append(parent);
    mountPopupAuth(parent, "http://127.0.0.1:4321");
    await waitFor(() => document.querySelector("#simmer-auth form") instanceof dom.window.HTMLFormElement);
    const email = document.querySelector<HTMLInputElement>("input[name='email']");
    const password = document.querySelector<HTMLInputElement>("input[name='password']");
    assert.ok(email && password);
    email.value = "ada@example.com";
    password.value = "correct horse battery";
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Sign up")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => document.getElementById("simmer-survey")?.hidden === false);
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save survey");
    assert.ok(save instanceof dom.window.HTMLButtonElement);
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => save.disabled);
    assert.equal(save.disabled, true);
    release?.();
    await waitFor(() => document.getElementById("simmer-survey")?.hidden === true);
  });

  it("loads and saves hourly income and weekly budget, then signs out", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    const calls: { url: string; method: string; authorization: string | null; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as { hourlyRate?: number; weeklyBudget?: number }) : null;
      calls.push({ url, method, authorization: headers.get("authorization"), body });
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/auth/logout")) {
        return json({ ok: true });
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: true, hourlyRate: 42, weeklyBudget: 150 });
      }
      if (url.endsWith("/settings") && method === "PATCH") {
        return json({ hourlyRate: body?.hourlyRate, weeklyBudget: body?.weeklyBudget });
      }
      if (url.endsWith("/settings")) {
        return json({ hourlyRate: 42, weeklyBudget: 150 });
      }
      if (url.includes("/purchases/history")) {
        return json({ purchases: [] });
      }
      return json({ error: "missing" }, 404);
    }) as typeof fetch;

    const parent = document.createElement("div");
    document.body.append(parent);
    mountPopupAuth(parent, "http://127.0.0.1:4321");
    await waitFor(() => document.querySelector("#simmer-auth form") instanceof dom.window.HTMLFormElement);
    const email = document.querySelector<HTMLInputElement>("input[name='email']");
    const password = document.querySelector<HTMLInputElement>("input[name='password']");
    assert.ok(email && password);
    email.value = "ada@example.com";
    password.value = "correct horse battery";
    document.querySelectorAll("button")[0]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const empty = [...document.querySelectorAll("p")].find((node) => node.textContent === "No purchases yet.");
      return stored.simmer_token === "jwt-from-signup" && empty?.hidden === false;
    });
    assert.equal(document.getElementById("simmer-auth")?.textContent?.includes("Sign out"), true);

    const settingsTab = [...document.querySelectorAll("button")].find((button) => button.textContent === "Settings");
    assert.ok(settingsTab);
    settingsTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const income = document.querySelector<HTMLInputElement>("#simmer-settings input[name='income']");
    const budget = document.querySelector<HTMLInputElement>("#simmer-settings input[name='budget']");
    assert.ok(income && budget);
    await waitFor(() => income.value === "42" && budget.value === "150");
    const settings = document.getElementById("simmer-settings");
    assert.match(settings?.textContent ?? "", /Hourly income/);
    assert.match(settings?.textContent ?? "", /Weekly budget/);
    assert.equal(settings?.textContent?.includes("hourlyRate"), false);
    income.value = "55";
    budget.value = "80";
    const save = [...(settings?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Save");
    assert.ok(save);
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => calls.some((call) => call.url.endsWith("/settings") && call.method === "PATCH"));
    const patch = calls.find((call) => call.url.endsWith("/settings") && call.method === "PATCH");
    assert.ok(patch);
    assert.equal(patch.authorization, "Bearer jwt-from-signup");
    assert.deepEqual(patch.body, { hourlyRate: 55, weeklyBudget: 80 });
    await waitFor(() => settings?.textContent?.includes("Saved.") === true);

    const signOut = [...document.querySelectorAll("button")].find((button) => button.textContent === "Sign out");
    assert.ok(signOut);
    signOut.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => document.querySelector<HTMLFormElement>("#simmer-auth form")?.hidden === false);
    assert.equal(stored.simmer_token, "");
    assert.equal(document.getElementById("simmer-settings")?.hidden, true);
  });

});

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
    if (Date.now() - start > 1000) {
      throw new Error("Timed out waiting for the popup survey.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
