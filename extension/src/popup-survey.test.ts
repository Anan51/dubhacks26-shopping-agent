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
    const logout = calls.find((call) => call.url.endsWith("/auth/logout"));
    assert.equal(logout?.authorization, "Bearer jwt-from-signup");
  });

  it("saves only the income field when the weekly budget is still zero", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    const patches: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: true, hourlyRate: null, weeklyBudget: 0 });
      }
      if (url.endsWith("/settings") && method === "PATCH") {
        patches.push(JSON.parse(String(init?.body)));
        return json({ hourlyRate: 30, weeklyBudget: 0 });
      }
      if (url.endsWith("/settings")) {
        return json({ hourlyRate: null, weeklyBudget: 0 });
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
    const settingsTab = [...document.querySelectorAll("button")].find((button) => button.textContent === "Settings");
    assert.ok(settingsTab);
    settingsTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const income = document.querySelector<HTMLInputElement>("#simmer-settings input[name='income']");
    const budget = document.querySelector<HTMLInputElement>("#simmer-settings input[name='budget']");
    assert.ok(income && budget);
    await waitFor(() => budget.value === "0");
    assert.equal(income.value, "");
    income.value = "30";
    settingsTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(income.value, "30");
    const save = [...document.querySelectorAll("#simmer-settings button")].find((button) => button.textContent === "Save");
    assert.ok(save);
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => patches.length === 1);
    assert.deepEqual(patches[0], { hourlyRate: 30 });
  });

  it("keeps a saved amount when the opening settings load finishes late", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    let releaseGet: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let settingsGets = 0;
    const patches: { hourlyRate?: number; weeklyBudget?: number }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: true, hourlyRate: null, weeklyBudget: null });
      }
      if (url.endsWith("/settings") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { hourlyRate?: number; weeklyBudget?: number };
        patches.push(body);
        return json({ hourlyRate: body.hourlyRate ?? null, weeklyBudget: body.weeklyBudget ?? null });
      }
      if (url.endsWith("/settings")) {
        settingsGets += 1;
        if (settingsGets === 1) {
          await gate;
        }
        return json({ hourlyRate: null, weeklyBudget: null });
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
    await waitFor(() => stored.simmer_token === "jwt-from-signup");
    const settingsTab = [...document.querySelectorAll("button")].find((button) => button.textContent === "Settings");
    assert.ok(settingsTab);
    settingsTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const income = document.querySelector<HTMLInputElement>("#simmer-settings input[name='income']");
    assert.ok(income);
    income.value = "40";
    const save = [...document.querySelectorAll("#simmer-settings button")].find((button) => button.textContent === "Save");
    assert.ok(save);
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => patches.length === 1);
    assert.deepEqual(patches[0], { hourlyRate: 40 });
    assert.equal(income.value, "40");
    releaseGet();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(income.value, "40");
    income.value = "55";
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => patches.length === 2);
    assert.deepEqual(patches[1], { hourlyRate: 55 });
  });

  it("keeps a saved amount when the settings body arrives after Save", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    let releaseBody: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let settingsGets = 0;
    const patches: { hourlyRate?: number; weeklyBudget?: number }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: true, hourlyRate: null, weeklyBudget: null });
      }
      if (url.endsWith("/settings") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { hourlyRate?: number; weeklyBudget?: number };
        patches.push(body);
        return json({ hourlyRate: body.hourlyRate ?? null, weeklyBudget: body.weeklyBudget ?? null });
      }
      if (url.endsWith("/settings")) {
        settingsGets += 1;
        if (settingsGets === 1) {
          return heldJson({ hourlyRate: null, weeklyBudget: null }, gate);
        }
        return json({ hourlyRate: null, weeklyBudget: null });
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
    await waitFor(() => stored.simmer_token === "jwt-from-signup");
    const settingsTab = [...document.querySelectorAll("button")].find((button) => button.textContent === "Settings");
    assert.ok(settingsTab);
    settingsTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => settingsGets === 1);
    const income = document.querySelector<HTMLInputElement>("#simmer-settings input[name='income']");
    assert.ok(income);
    income.value = "40";
    const save = [...document.querySelectorAll("#simmer-settings button")].find((button) => button.textContent === "Save");
    assert.ok(save);
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => patches.length === 1 && document.body.textContent?.includes("Saved.") === true);
    assert.equal(income.value, "40");
    releaseBody();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(income.value, "40");
    const savedNote = [...document.querySelectorAll<HTMLElement>("#simmer-settings p")].find((node) => node.textContent === "Saved.");
    assert.equal(savedNote?.hidden, false);
    income.value = "55";
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => patches.length === 2);
    assert.deepEqual(patches[1], { hourlyRate: 55 });
  });

  it("shows the saved amounts when the popup is opened again", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    let hourlyRate: number | null = null;
    let weeklyBudget: number | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me")) {
        if (stored.simmer_token === "jwt-from-signup") {
          return json({ user: { id: "user-1", email: "ada@example.com" } });
        }
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: true, hourlyRate, weeklyBudget });
      }
      if (url.endsWith("/settings") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { hourlyRate?: number; weeklyBudget?: number };
        if (body.hourlyRate !== undefined) {
          hourlyRate = body.hourlyRate;
        }
        if (body.weeklyBudget !== undefined) {
          weeklyBudget = body.weeklyBudget;
        }
        return json({ hourlyRate, weeklyBudget });
      }
      if (url.endsWith("/settings")) {
        return json({ hourlyRate, weeklyBudget });
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
    await waitFor(() => stored.simmer_token === "jwt-from-signup");
    let settingsTab = [...document.querySelectorAll("button")].find((button) => button.textContent === "Settings");
    assert.ok(settingsTab);
    settingsTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const income = document.querySelector<HTMLInputElement>("#simmer-settings input[name='income']");
    const budget = document.querySelector<HTMLInputElement>("#simmer-settings input[name='budget']");
    assert.ok(income && budget);
    await waitFor(() => income.value === "" && budget.value === "");
    income.value = "55";
    budget.value = "90";
    const save = [...document.querySelectorAll("#simmer-settings button")].find((button) => button.textContent === "Save");
    assert.ok(save);
    save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await waitFor(() => income.value === "55" && budget.value === "90" && document.body.textContent?.includes("Saved.") === true);

    parent.replaceChildren();
    mountPopupAuth(parent, "http://127.0.0.1:4321");
    await waitFor(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Settings"));
    settingsTab = [...document.querySelectorAll("button")].find((button) => button.textContent === "Settings");
    assert.ok(settingsTab);
    settingsTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const reopenedIncome = document.querySelector<HTMLInputElement>("#simmer-settings input[name='income']");
    const reopenedBudget = document.querySelector<HTMLInputElement>("#simmer-settings input[name='budget']");
    assert.ok(reopenedIncome && reopenedBudget);
    await waitFor(() => reopenedIncome.value === "55" && reopenedBudget.value === "90");
  });

  it("saves an hourly rate when no past purchases were added", async () => {
    const posted = installSurveyFetch(dom, () => json({ completed: true, hourlyRate: 42, weeklyBudget: null, purchases: [] }, 201));
    await signUpToSurvey(dom);
    const hourly = document.querySelector<HTMLInputElement>("input[name='hourlyRate']");
    assert.ok(hourly);
    hourly.value = "42";
    clickButton("Save survey");
    await waitFor(() => document.getElementById("simmer-survey")?.hidden === true);
    const surveyPost = posted.find((call) => call.url.endsWith("/onboarding/survey"));
    assert.ok(surveyPost);
    assert.deepEqual(surveyPost.body, { hourlyRate: 42, weeklyBudget: null, recentPurchases: [] });
    assert.equal(surveyPost.authorization, "Bearer jwt-from-signup");
    assert.equal(document.querySelector("#simmer-survey .error")?.hasAttribute("hidden"), true);
  });

  it("saves an hourly rate and a purchase priced like $12.99", async () => {
    const posted = installSurveyFetch(dom, () => json({ completed: true, hourlyRate: 18, weeklyBudget: 90, purchases: [] }, 201));
    await signUpToSurvey(dom);
    const hourly = document.querySelector<HTMLInputElement>("input[name='hourlyRate']");
    const weekly = document.querySelector<HTMLInputElement>("input[name='weeklyBudget']");
    assert.ok(hourly && weekly);
    hourly.value = "$18";
    weekly.value = "90";
    clickButton("Add a recent purchase");
    clickButton("Add a recent purchase");
    const items = [...document.querySelectorAll<HTMLInputElement>("input[aria-label='Recent purchase item']")];
    const prices = [...document.querySelectorAll<HTMLInputElement>("input[aria-label='Recent purchase price']")];
    const boxes = [...document.querySelectorAll<HTMLInputElement>("#simmer-survey input[type='checkbox']")];
    assert.equal(items.length, 2);
    assert.ok(items[0] && items[1] && prices[0] && prices[1] && boxes[0] && boxes[1]);
    items[0].value = "AirPods";
    prices[0].value = "$12.99";
    boxes[0].checked = true;
    items[1].value = "Cable";
    prices[1].value = "12,99";
    boxes[1].checked = false;
    clickButton("Save survey");
    await waitFor(() => document.getElementById("simmer-survey")?.hidden === true);
    const surveyPost = posted.find((call) => call.url.endsWith("/onboarding/survey"));
    assert.ok(surveyPost);
    assert.deepEqual(surveyPost.body, {
      hourlyRate: 18,
      weeklyBudget: 90,
      recentPurchases: [
        { item: "AirPods", price: 12.99, regretted: true },
        { item: "Cable", price: 12.99, regretted: false },
      ],
    });
  });

  it("reloads the survey and says it is already completed on 409", async () => {
    globalThis.document = dom.window.document;
    installChrome();
    const calls: { url: string; method: string }[] = [];
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/auth/me")) {
        return json({ error: "Authentication required." }, 401);
      }
      if (url.endsWith("/auth/signup")) {
        return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
      }
      if (url.endsWith("/onboarding/survey") && method === "POST") {
        posts += 1;
        return json({ error: "Survey already completed." }, 409);
      }
      if (url.endsWith("/onboarding/survey")) {
        return json({ completed: posts > 0, hourlyRate: posts > 0 ? 10 : null, weeklyBudget: null });
      }
      if (url.includes("/purchases/history")) {
        return json({ purchases: [] });
      }
      return json({ error: "missing" }, 404);
    }) as typeof fetch;
    await signUpToSurvey(dom);
    const getsBefore = calls.filter((call) => call.url.endsWith("/onboarding/survey") && call.method === "GET").length;
    const hourly = document.querySelector<HTMLInputElement>("input[name='hourlyRate']");
    assert.ok(hourly);
    hourly.value = "99";
    clickButton("Save survey");
    await waitFor(() => document.querySelector("#simmer-survey .error")?.textContent === "Survey already completed.");
    const getsAfter = calls.filter((call) => call.url.endsWith("/onboarding/survey") && call.method === "GET").length;
    assert.equal(getsAfter, getsBefore + 1);
    const surveyError = document.querySelector("#simmer-survey .error");
    assert.equal(surveyError?.hasAttribute("hidden"), false);
    assert.equal(surveyError?.textContent?.includes("Could not save the survey."), false);
    const savedNote = [...document.querySelectorAll("#simmer-settings p")].find((node) => node.textContent === "Saved.");
    assert.equal(savedNote?.hasAttribute("hidden"), true);
    assert.equal(document.getElementById("simmer-settings")?.hidden, true);
    assert.equal(document.getElementById("simmer-purchases")?.hidden, true);
    assert.equal(document.getElementById("simmer-survey")?.hidden, false);
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save survey");
    assert.ok(save instanceof dom.window.HTMLButtonElement);
    assert.equal(save.hidden, true);
    assert.equal(save.disabled, true);
    assert.equal(hourly.hidden || hourly.disabled, true);
  });

  it("shows the server status and error when the survey save is refused", async () => {
    installSurveyFetch(dom, () => json({ error: "User not found." }, 404));
    await signUpToSurvey(dom);
    const hourly = document.querySelector<HTMLInputElement>("input[name='hourlyRate']");
    assert.ok(hourly);
    hourly.value = "42";
    clickButton("Save survey");
    await waitFor(() => document.querySelector("#simmer-survey .error")?.textContent === "404 User not found.");
    assert.equal(document.getElementById("simmer-survey")?.hidden, false);
  });

  it("does not send a purchase that has an item and no valid price", async () => {
    const posted = installSurveyFetch(dom, () => json({ completed: true, hourlyRate: 42, weeklyBudget: null, purchases: [] }, 201));
    await signUpToSurvey(dom);
    const hourly = document.querySelector<HTMLInputElement>("input[name='hourlyRate']");
    assert.ok(hourly);
    hourly.value = "42";
    clickButton("Add a recent purchase");
    const item = document.querySelector<HTMLInputElement>("input[aria-label='Recent purchase item']");
    const price = document.querySelector<HTMLInputElement>("input[aria-label='Recent purchase price']");
    assert.ok(item && price);
    item.value = "Mug";
    price.value = "";
    clickButton("Save survey");
    await waitFor(() => document.querySelector(".purchase .row-error")?.textContent === "Enter a price.");
    assert.equal(posted.some((call) => call.url.endsWith("/onboarding/survey")), false);
    assert.equal(document.getElementById("simmer-survey")?.hidden, false);
  });

});

function installSurveyFetch(
  dom: JSDOM,
  onSurveyPost: () => Response,
): { url: string; body: unknown; authorization: string | null }[] {
  globalThis.document = dom.window.document;
  installChrome();
  const posted: { url: string; body: unknown; authorization: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") {
      posted.push({
        url,
        body: init.body ? JSON.parse(String(init.body)) : null,
        authorization: headers.get("authorization"),
      });
    }
    if (url.endsWith("/auth/me")) {
      return json({ error: "Authentication required." }, 401);
    }
    if (url.endsWith("/auth/signup")) {
      return json({ user: { id: "user-1", email: "ada@example.com" }, token: "jwt-from-signup" });
    }
    if (url.endsWith("/onboarding/survey") && init?.method === "POST") {
      return onSurveyPost();
    }
    if (url.endsWith("/onboarding/survey")) {
      return json({ completed: false, hourlyRate: null, weeklyBudget: null });
    }
    if (url.includes("/purchases/history")) {
      return json({ purchases: [] });
    }
    return json({ error: "missing" }, 404);
  }) as typeof fetch;
  return posted;
}

async function signUpToSurvey(dom: JSDOM): Promise<void> {
  const parent = document.createElement("div");
  document.body.append(parent);
  assert.equal(mountPopupAuth(parent, "http://127.0.0.1:4321"), true);
  await waitFor(() => document.querySelector("#simmer-auth form") instanceof dom.window.HTMLFormElement);
  const email = document.querySelector<HTMLInputElement>("input[name='email']");
  const password = document.querySelector<HTMLInputElement>("input[name='password']");
  assert.ok(email && password);
  email.value = "ada@example.com";
  password.value = "correct horse battery";
  clickButton("Sign up");
  await waitFor(() => document.getElementById("simmer-survey")?.hidden === false);
}

function clickButton(label: string): void {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  assert.ok(button);
  const view = button.ownerDocument.defaultView;
  assert.ok(view);
  button.dispatchEvent(new view.MouseEvent("click", { bubbles: true }));
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

function heldJson(body: unknown, gate: Promise<void>): Response {
  const stream = new ReadableStream({
    async start(controller) {
      await gate;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
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
