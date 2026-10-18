import { isRecord } from "../../src/record.js";
import { authOriginFromStorage } from "./auth-flag.js";

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
    "#simmer-auth form, #simmer-auth .signed { display: flex; flex-direction: column; gap: 0.35rem; }",
    "#simmer-auth input, #simmer-auth button { font: inherit; }",
    "#simmer-auth input { border: 1px solid #eadccb; border-radius: 0.55rem; padding: 0.35rem 0.45rem; background: #fffaf3; color: inherit; }",
    "#simmer-auth .row { display: flex; gap: 0.35rem; }",
    "#simmer-auth button { background: #8a4b24; color: white; border: 0; border-radius: 999px; padding: 0.35rem 0.7rem; cursor: pointer; }",
    "#simmer-auth .error { color: #8a4b24; font-size: 0.75rem; margin: 0; }",
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
  const login = actionButton("Log in");
  row.append(signup, login);
  form.append(email.label, password.label, row, error);

  const signed = document.createElement("div");
  signed.className = "signed";
  signed.hidden = true;
  const who = document.createElement("p");
  who.className = "fine";
  const logout = actionButton("Log out");
  signed.append(who, logout);

  section.append(form, signed);
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
      const response = await authFetch(origin, kind === "signup" ? "/auth/signup" : "/auth/login", body);
      if (!response.ok) {
        showError(kind === "login" ? LOGIN_ERROR : SIGNUP_ERROR);
        return;
      }
      const account = await readUser(response);
      if (!account) {
        showError(kind === "login" ? LOGIN_ERROR : SIGNUP_ERROR);
        return;
      }
      showSignedIn(account.email);
    } catch {
      showError(REACH_ERROR);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const response = await authFetch(origin, "/auth/me");
      if (!response.ok) {
        showSignedOut();
        return;
      }
      const account = await readUser(response);
      if (!account) {
        showSignedOut();
        return;
      }
      showSignedIn(account.email);
    } catch {
      showSignedOut();
    }
  }

  async function signOut(): Promise<void> {
    hideError();
    try {
      await authFetch(origin, "/auth/logout", {});
    } catch {
      showError(REACH_ERROR);
      return;
    }
    password.input.value = "";
    showSignedOut();
  }

  function showSignedIn(address: string): void {
    form.hidden = true;
    signed.hidden = false;
    who.textContent = address;
  }

  function showSignedOut(): void {
    form.hidden = false;
    signed.hidden = true;
    who.textContent = "";
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

/** credentials: include so the httpOnly simmer_token cookie is stored and sent. */
async function authFetch(origin: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readUser(response: Response): Promise<{ email: string } | null> {
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !isRecord(body.user) || typeof body.user.email !== "string") {
    return null;
  }
  return { email: body.user.email };
}

