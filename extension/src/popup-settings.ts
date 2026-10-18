import { isRecord } from "../../src/record.js";
import { authorizedFetch } from "./popup-fetch.js";

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
  let hourlyBaseline = "";
  let weeklyBaseline = "";
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
    try {
      const response = await authorizedFetch(`${origin}/settings`, undefined, authorization, onUnauthorized);
      if (id !== loadId || !response) {
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
      hourlyBaseline = applyLoaded(hourly.input, hourlyBaseline, body.hourlyRate);
      weeklyBaseline = applyLoaded(weekly.input, weeklyBaseline, body.weeklyBudget);
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
    const patch: { hourlyRate?: number; weeklyBudget?: number } = {};
    const hourlyRate = changedAmount(hourly.input, hourlyBaseline);
    const weeklyBudget = changedAmount(weekly.input, weeklyBaseline);
    if (hourlyRate === "invalid") {
      showError("Hourly income needs to be a number above zero.");
      return;
    }
    if (weeklyBudget === "invalid") {
      showError("Weekly budget needs to be a number above zero.");
      return;
    }
    if (hourlyRate !== undefined) {
      patch.hourlyRate = hourlyRate;
    }
    if (weeklyBudget !== undefined) {
      patch.weeklyBudget = weeklyBudget;
    }
    if (patch.hourlyRate === undefined && patch.weeklyBudget === undefined) {
      showError("Change hourly income or weekly budget before saving.");
      return;
    }
    const id = ++loadId;
    try {
      const response = await authorizedFetch(`${origin}/settings`, { method: "PATCH", body: patch }, authorization, onUnauthorized);
      if (id !== loadId || !response) {
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as unknown;
        const message = response.status === 400 && isRecord(body) && typeof body.error === "string" ? body.error : "Couldn't save settings.";
        showError(message);
        return;
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (id !== loadId) {
        return;
      }
      if (isRecord(body)) {
        if ("hourlyRate" in body) {
          hourly.input.value = moneyValue(body.hourlyRate);
          hourlyBaseline = hourly.input.value;
        }
        if ("weeklyBudget" in body) {
          weekly.input.value = moneyValue(body.weeklyBudget);
          weeklyBaseline = weekly.input.value;
        }
      }
      saved.hidden = false;
    } catch {
      showError("Couldn't save settings.");
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

function applyLoaded(input: HTMLInputElement, baseline: string, value: unknown): string {
  const next = moneyValue(value);
  if (input.value === baseline) {
    input.value = next;
    return next;
  }
  return baseline;
}

function changedAmount(input: HTMLInputElement, baseline: string): number | undefined | "invalid" {
  if (input.value.trim() === baseline.trim()) {
    return undefined;
  }
  const parsed = readPositive(input.value);
  if (parsed === null) {
    return "invalid";
  }
  return parsed;
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

