import { isRecord } from "../../src/record.js";
import { authOriginFromStorage } from "./auth-flag.js";
import { authorizedFetch } from "./popup-fetch.js";
import { attachPurchaseHistory } from "./popup-purchases.js";
import { attachSettings } from "./popup-settings.js";
import { attachSurvey } from "./popup-survey.js";

const LOGIN_ERROR = "Invalid email or password.";
const SIGNUP_ERROR = "Could not sign up.";
const REACH_ERROR = "Could not reach the server.";
const AUTH_HINT = "Set the Auth server URL in Options (http://127.0.0.1:<port>) to sign in.";

export type PopupAccount = {
  id: string;
  email: string;
  token: string | null;
};

export function mountPopupAuth(
  parent: HTMLElement,
  originValue: unknown,
  hooks?: { onAuthChange?: (account: PopupAccount | null) => void },
): boolean {
  const parsed = authOriginFromStorage(originValue);
  if (!parsed) {
    mountAuthServerHint(parent);
    return false;
  }
  const origin: string = parsed;

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
  const signup = actionButton("Sign up", "secondary");
  const login = actionButton("Sign in", "primary");
  row.append(signup, login);
  form.append(email.label, password.label, row, error);

  const signed = document.createElement("div");
  signed.className = "signed";
  signed.hidden = true;
  const who = document.createElement("p");
  who.className = "fine";
  const logout = actionButton("Sign out", "secondary");
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

  const account = document.createElement("div");
  account.className = "panel";
  const accountHeader = document.createElement("p");
  accountHeader.className = "card-header";
  accountHeader.textContent = "Account";
  account.append(accountHeader, form, signed);
  section.append(account);
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
  parent.prepend(section);
  let announcedId: string | null = null;

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
      await showSignedIn(account);
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
      await showSignedIn(account);
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
    const rejectedStoredToken = announcedId === null && failedToken !== null;
    sessionToken = null;
    await clearStoredToken();
    showSignedOut(rejectedStoredToken);
  }

  async function showSignedIn(account: { id: string; email: string; token: string | null }): Promise<void> {
    const view = ++viewEpoch;
    if (account.token) {
      sessionToken = account.token;
      await storeToken(account.token);
    } else if (!sessionToken) {
      sessionToken = await readStoredToken();
    }
    if (view !== viewEpoch) {
      return;
    }
    form.hidden = true;
    signed.hidden = false;
    who.textContent = account.email;
    announcedId = account.id;
    hooks?.onAuthChange?.({ id: account.id, email: account.email, token: sessionToken });
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

  function showSignedOut(notifyWhenUnannounced = false): void {
    form.hidden = false;
    signed.hidden = true;
    who.textContent = "";
    survey.hide();
    hideAccountPanels();
    if (announcedId === null) {
      if (notifyWhenUnannounced) {
        hooks?.onAuthChange?.(null);
      }
      return;
    }
    announcedId = null;
    hooks?.onAuthChange?.(null);
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

function mountAuthServerHint(parent: HTMLElement): void {
  const section = document.createElement("section");
  section.id = "simmer-auth-hint";
  section.className = "panel";
  const message = document.createElement("p");
  message.className = "fine";
  message.textContent = AUTH_HINT;
  const options = actionButton("Options", "primary");
  options.addEventListener("click", () => {
    openOptionsPage();
  });
  section.append(message, options);
  parent.prepend(section);
}

function openOptionsPage(): void {
  const runtime = extensionRuntime();
  if (!runtime || typeof runtime.openOptionsPage !== "function") {
    return;
  }
  try {
    void Promise.resolve(runtime.openOptionsPage()).catch(() => undefined);
  } catch {
    return;
  }
}

function extensionRuntime(): { openOptionsPage?: () => void | Promise<unknown> } | null {
  const host = globalThis as { chrome?: { runtime?: { openOptionsPage?: () => void | Promise<unknown> } } };
  return host.chrome?.runtime ?? null;
}

function tabButton(text: string): HTMLButtonElement {
  const button = actionButton(text, "secondary");
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

function actionButton(text: string, kind: "primary" | "secondary"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = kind === "primary" ? "btn-primary" : "btn-secondary";
  button.textContent = text;
  return button;
}

async function readUser(response: Response): Promise<{ id: string; email: string; token: string | null } | null> {
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !isRecord(body.user) || typeof body.user.email !== "string" || typeof body.user.id !== "string") {
    return null;
  }
  const id = body.user.id.trim();
  if (id.length === 0) {
    return null;
  }
  const token = typeof body.token === "string" && body.token.length > 0 ? body.token : null;
  return { id, email: body.user.email, token };
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
