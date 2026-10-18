import { isRecord } from "../../src/record.js";
import { authOriginFromStorage } from "./auth-flag.js";
import { authorizedFetch } from "./popup-fetch.js";
import { attachPurchaseHistory } from "./popup-purchases.js";
import { attachSettings } from "./popup-settings.js";
import { attachSurvey } from "./popup-survey.js";

const LOGIN_ERROR = "Invalid email or password.";
const SIGNUP_ERROR = "Could not sign up.";
const REACH_ERROR = "Could not reach the server.";

export function mountPopupAuth(parent: HTMLElement, originValue: unknown): boolean {
  const parsed = authOriginFromStorage(originValue);
  if (!parsed) {
    return false;
  }
  const origin: string = parsed;

  const style = document.createElement("style");
  style.textContent = [
    "#simmer-auth { padding: 0.7rem 0.9rem 0; }",
    "#simmer-auth form, #simmer-auth .signed, #simmer-settings { display: flex; flex-direction: column; gap: 0.35rem; }",
    "#simmer-auth input, #simmer-auth button { font: inherit; }",
    "#simmer-auth input { border: 1px solid #eadccb; border-radius: 0.55rem; padding: 0.35rem 0.45rem; background: #fffaf3; color: inherit; }",
    "#simmer-auth .row, #simmer-auth .tabs { display: flex; gap: 0.35rem; }",
    "#simmer-auth button { background: #8a4b24; color: white; border: 0; border-radius: 999px; padding: 0.35rem 0.7rem; cursor: pointer; }",
    "#simmer-auth .tabs button { background: transparent; color: inherit; border: 1px solid #eadccb; }",
    "#simmer-auth .tabs button[aria-selected='true'] { background: #8a4b24; color: white; border-color: #8a4b24; }",
    "#simmer-auth .error { color: #8a4b24; font-size: 0.75rem; margin: 0; }",
    "#simmer-settings { padding-bottom: 0.6rem; }",
  ].join("");

  const section = document.createElement("section");
  section.id = "simmer-auth";

  const form = document.createElement("form");
  const email = field("email", "Email", "email");
  const password = field("password", "Password", "password");
  const error = document.createElement("p");
  error.className = "error";
  error.hidden = true;
  const row = document.createElement("div");
  row.className = "row";
  const signup = actionButton("Sign up");
  const login = actionButton("Sign in");
  row.append(signup, login);
  form.append(email.label, password.label, row, error);

  const signed = document.createElement("div");
  signed.className = "signed";
  signed.hidden = true;
  const who = document.createElement("p");
  who.className = "fine";
  const logout = actionButton("Sign out");
  signed.append(who, logout);

  const tabs = document.createElement("div");
  tabs.className = "tabs";
  tabs.setAttribute("role", "tablist");
  tabs.hidden = true;
  const purchasesTab = tabButton("Past purchases");
  const settingsTab = tabButton("Settings");
  tabs.append(purchasesTab, settingsTab);

  const purchasesPanel = document.createElement("div");
  purchasesPanel.hidden = true;
  const settingsPanel = document.createElement("div");
  settingsPanel.hidden = true;

  section.append(form, signed);
  let sessionToken: string | null = null;
  let viewEpoch = 0;
  const authorization = async (): Promise<string | null> => {
    if (sessionToken) {
      return sessionToken;
    }
    sessionToken = await readStoredToken();
    return sessionToken;
  };
  const history = attachPurchaseHistory(purchasesPanel, origin, authorization, unauthorized);
  const settings = attachSettings(settingsPanel, origin, authorization, unauthorized);
  const survey = attachSurvey(section, origin, authorization, () => {
    showPurchases();
  }, unauthorized);
  section.append(tabs, purchasesPanel, settingsPanel);
  parent.prepend(style, section);

  signup.addEventListener("click", () => {
    void submit("signup");
  });
  login.addEventListener("click", () => {
    void submit("login");
  });
  logout.addEventListener("click", () => {
    void signOut();
  });
  purchasesTab.addEventListener("click", () => {
    showPurchases();
  });
  settingsTab.addEventListener("click", () => {
    showSettings();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit("login");
  });

  void refresh();
  return true;

  async function submit(kind: "signup" | "login"): Promise<void> {
    hideError();
    const body = { email: email.input.value.trim(), password: password.input.value };
    try {
      const response = await fetch(`${origin}${kind === "signup" ? "/auth/signup" : "/auth/login"}`, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        showError(kind === "login" ? LOGIN_ERROR : SIGNUP_ERROR);
        return;
      }
      const account = await readUser(response);
      if (!account) {
        showError(kind === "login" ? LOGIN_ERROR : SIGNUP_ERROR);
        return;
      }
      await showSignedIn(account.email, account.token);
    } catch {
      showError(REACH_ERROR);
    }
  }

  async function refresh(): Promise<void> {
    const view = viewEpoch;
    try {
      const response = await authorizedFetch(`${origin}/auth/me`, undefined, authorization, unauthorized);
      if (view !== viewEpoch || !response) {
        return;
      }
      if (!response.ok) {
        showSignedOut();
        return;
      }
      const account = await readUser(response);
      if (!account) {
        showSignedOut();
        return;
      }
      sessionToken = await readStoredToken();
      await showSignedIn(account.email);
    } catch {
      showSignedOut();
    }
  }

  async function signOut(): Promise<void> {
    viewEpoch += 1;
    hideError();
    try {
      const token = sessionToken ?? (await readStoredToken());
      await authorizedFetch(`${origin}/auth/logout`, { method: "POST", body: {} }, async () => token, unauthorized);
    } catch {
      showError(REACH_ERROR);
    }
    password.input.value = "";
    sessionToken = null;
    await clearStoredToken();
    showSignedOut();
  }

  async function unauthorized(failedToken: string | null): Promise<void> {
    if (sessionToken && sessionToken !== failedToken) {
      return;
    }
    viewEpoch += 1;
    sessionToken = null;
    await clearStoredToken();
    showSignedOut();
  }

  async function showSignedIn(address: string, token?: string | null): Promise<void> {
    const view = ++viewEpoch;
    if (token) {
      sessionToken = token;
      await storeToken(token);
    } else if (!sessionToken) {
      sessionToken = await readStoredToken();
    }
    form.hidden = true;
    signed.hidden = false;
    who.textContent = address;
    const completed = await survey.refresh();
    if (view !== viewEpoch || completed === "unauthorized") {
      return;
    }
    if (completed) {
      showPurchases();
    } else {
      hideAccountPanels();
    }
  }

  function showSignedOut(): void {
    form.hidden = false;
    signed.hidden = true;
    who.textContent = "";
    survey.hide();
    hideAccountPanels();
  }

  function showPurchases(): void {
    tabs.hidden = false;
    purchasesPanel.hidden = false;
    settingsPanel.hidden = true;
    purchasesTab.setAttribute("aria-selected", "true");
    settingsTab.setAttribute("aria-selected", "false");
    settings.hide();
    history.show();
  }

  function showSettings(): void {
    tabs.hidden = false;
    purchasesPanel.hidden = true;
    settingsPanel.hidden = false;
    purchasesTab.setAttribute("aria-selected", "false");
    settingsTab.setAttribute("aria-selected", "true");
    history.hide();
    settings.show();
  }

  function hideAccountPanels(): void {
    tabs.hidden = true;
    purchasesPanel.hidden = true;
    settingsPanel.hidden = true;
    purchasesTab.setAttribute("aria-selected", "false");
    settingsTab.setAttribute("aria-selected", "false");
    settings.hide();
    history.hide();
  }

  function showError(message: string): void {
    error.hidden = false;
    error.textContent = message;
  }

  function hideError(): void {
    error.hidden = true;
    error.textContent = "";
  }
}

function tabButton(text: string): HTMLButtonElement {
  const button = actionButton(text);
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", "false");
  return button;
}

function field(name: string, labelText: string, type: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.autocomplete = type === "password" ? "current-password" : "username";
  input.required = true;
  label.append(input);
  return { label, input };
}

function actionButton(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  return button;
}

async function readUser(response: Response): Promise<{ email: string; token: string | null } | null> {
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !isRecord(body.user) || typeof body.user.email !== "string") {
    return null;
  }
  const token = typeof body.token === "string" && body.token.length > 0 ? body.token : null;
  return { email: body.user.email, token };
}

function storeToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ simmer_token: token }, () => resolve());
  });
}

function clearStoredToken(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ simmer_token: "" }, () => resolve());
  });
}

function readStoredToken(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["simmer_token"], (items) => {
      const value = items.simmer_token;
      resolve(typeof value === "string" && value.length > 0 ? value : null);
    });
  });
}
