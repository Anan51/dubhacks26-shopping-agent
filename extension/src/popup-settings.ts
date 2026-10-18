import { isRecord } from "../../src/record.js";

export function attachSettings(
  parent: HTMLElement,
  origin: string,
  authorization: () => Promise<string | null>,
  onUnauthorized: (token: string | null) => Promise<void>,
): { show(): void; hide(): void } {
  const section = document.createElement("section");
  section.id = "simmer-settings";
  section.hidden = true;
  const hourly = moneyField("income", "Hourly income");
  const weekly = moneyField("budget", "Weekly budget");
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  const error = document.createElement("p");
  error.className = "error";
  error.hidden = true;
  const saved = document.createElement("p");
  saved.className = "fine";
  saved.textContent = "Saved.";
  saved.hidden = true;
  section.append(hourly.label, weekly.label, save, error, saved);
  parent.append(section);

  let loadId = 0;
  save.addEventListener("click", () => {
    void submit();
  });

  return {
    show() {
      section.hidden = false;
      void load();
    },
    hide() {
      section.hidden = true;
      error.hidden = true;
      saved.hidden = true;
    },
  };

  async function load(): Promise<void> {
    const id = ++loadId;
    error.hidden = true;
    saved.hidden = true;
    const token = await authorization();
    try {
      const response = await settingsFetch(origin, "GET", authorization);
      if (id !== loadId) {
        return;
      }
      if (response.status === 401) {
        await onUnauthorized(token);
        return;
      }
      if (!response.ok) {
        showError("Could not load your settings.");
        return;
      }
      const body = (await response.json()) as unknown;
      if (!isRecord(body)) {
        showError("Could not load your settings.");
        return;
      }
      hourly.input.value = moneyValue(body.hourlyRate);
      weekly.input.value = moneyValue(body.weeklyBudget);
    } catch {
      if (id !== loadId) {
        return;
      }
      showError("Could not load your settings.");
    }
  }

  async function submit(): Promise<void> {
    error.hidden = true;
    saved.hidden = true;
    const hourlyRate = readPositive(hourly.input.value);
    const weeklyBudget = readPositive(weekly.input.value);
    if (hourlyRate === null || weeklyBudget === null) {
      showError("Hourly income and weekly budget need to be numbers above zero.");
      return;
    }
    const token = await authorization();
    try {
      const response = await settingsFetch(origin, "PATCH", authorization, { hourlyRate, weeklyBudget });
      if (response.status === 401) {
        await onUnauthorized(token);
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as unknown;
        showError(isRecord(body) && typeof body.error === "string" ? body.error : "Could not save.");
        return;
      }
      saved.hidden = false;
    } catch {
      showError("Could not save.");
    }
  }

  function showError(message: string): void {
    error.hidden = false;
    error.textContent = message;
  }
}

function moneyField(name: string, labelText: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.name = name;
  input.type = "number";
  input.min = "0.01";
  input.step = "0.01";
  input.inputMode = "decimal";
  label.append(input);
  return { label, input };
}

function moneyValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function readPositive(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

async function settingsFetch(
  origin: string,
  method: "GET" | "PATCH",
  authorization: () => Promise<string | null>,
  body?: unknown,
): Promise<Response> {
  const token = await authorization();
  return fetch(`${origin}/settings`, {
    method,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
