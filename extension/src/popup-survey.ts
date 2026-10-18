import { isRecord } from "../../src/record.js";

export type SurveyState = {
  completed: boolean;
  hourlyRate: number | null;
  weeklyBudget: number | null;
};

export function attachSurvey(
  parent: HTMLElement,
  origin: string,
  authorization: () => Promise<string | null>,
  onComplete: () => void,
  onUnauthorized: (token: string | null) => Promise<void>,
): { refresh(): Promise<boolean | "unauthorized">; hide(): void } {
  const style = document.createElement("style");
  style.textContent = [
    "#simmer-survey { display: flex; flex-direction: column; gap: 0.35rem; padding-bottom: 0.4rem; }",
    "#simmer-survey input { font: inherit; border: 1px solid #eadccb; border-radius: 0.55rem; padding: 0.35rem 0.45rem; background: #fffaf3; color: inherit; }",
    "#simmer-survey .purchase { display: flex; gap: 0.25rem; align-items: center; }",
    "#simmer-survey button { font: inherit; background: #8a4b24; color: white; border: 0; border-radius: 999px; padding: 0.35rem 0.7rem; cursor: pointer; }",
    "#simmer-survey .error { color: #8a4b24; font-size: 0.75rem; margin: 0; }",
  ].join("");
  const section = document.createElement("section");
  section.id = "simmer-survey";
  section.hidden = true;
  const heading = document.createElement("p");
  heading.className = "kicker";
  heading.textContent = "A few questions before you shop";
  const hourly = moneyField("hourlyRate", "Rough hourly rate");
  const weekly = moneyField("weeklyBudget", "Rough weekly budget");
  const purchases = document.createElement("div");
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add a recent purchase";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save survey";
  const error = document.createElement("p");
  error.className = "error";
  error.hidden = true;
  section.append(heading, hourly.label, weekly.label, purchases, add, save, error);
  parent.append(style, section);

  const rows: PurchaseDraft[] = [];
  add.addEventListener("click", () => {
    if (rows.length >= 5) {
      return;
    }
    rows.push(addPurchaseRow(purchases));
  });
  save.addEventListener("click", () => {
    void submit();
  });

  return {
    async refresh() {
      error.hidden = true;
      const token = await authorization();
      const state = await loadSurvey(origin, authorization);
      if (state === "unauthorized") {
        await onUnauthorized(token);
        return "unauthorized";
      }
      const completed = state?.completed === true;
      section.hidden = completed;
      return completed;
    },
    hide() {
      section.hidden = true;
    },
  };

  async function submit(): Promise<void> {
    if (save.disabled) {
      return;
    }
    save.disabled = true;
    error.hidden = true;
    const recentPurchases = rows.flatMap((row) => {
      const item = row.item.value.trim();
      if (!item && row.price.value.trim() === "") {
        return [];
      }
      const price = Number(row.price.value);
      return [{ item, price: Number.isFinite(price) ? price : Number.NaN, regretted: row.regretted.checked }];
    });
    const token = await authorization();
    try {
      const response = await surveyFetch(origin, "/onboarding/survey", authorization, {
        hourlyRate: readOptionalMoney(hourly.input.value),
        weeklyBudget: readOptionalMoney(weekly.input.value),
        recentPurchases,
      });
      if (response.status === 401) {
        await onUnauthorized(token);
        return;
      }
      if (!response.ok) {
        error.hidden = false;
        error.textContent = "Could not save the survey.";
        return;
      }
      section.hidden = true;
      onComplete();
    } catch {
      error.hidden = false;
      error.textContent = "Could not save the survey.";
    } finally {
      save.disabled = false;
    }
  }
}

type PurchaseDraft = { item: HTMLInputElement; price: HTMLInputElement; regretted: HTMLInputElement };

function moneyField(name: string, labelText: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.name = name;
  input.type = "number";
  input.min = "0";
  input.step = "0.01";
  input.inputMode = "decimal";
  label.append(input);
  return { label, input };
}

function addPurchaseRow(parent: HTMLElement): PurchaseDraft {
  const row = document.createElement("div");
  row.className = "purchase";
  const item = document.createElement("input");
  item.type = "text";
  item.placeholder = "Item";
  item.setAttribute("aria-label", "Recent purchase item");
  const price = document.createElement("input");
  price.type = "number";
  price.min = "0";
  price.step = "0.01";
  price.placeholder = "Price";
  price.setAttribute("aria-label", "Recent purchase price");
  const regretted = document.createElement("input");
  regretted.type = "checkbox";
  const regrettedLabel = document.createElement("label");
  regrettedLabel.append(regretted, document.createTextNode("Regretted"));
  row.append(item, price, regrettedLabel);
  parent.append(row);
  return { item, price, regretted };
}

function readOptionalMoney(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadSurvey(
  origin: string,
  authorization: () => Promise<string | null>,
): Promise<SurveyState | "unauthorized" | null> {
  const response = await surveyFetch(origin, "/onboarding/survey", authorization);
  if (response.status === 401) {
    return "unauthorized";
  }
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body.completed !== "boolean") {
    return null;
  }
  return {
    completed: body.completed,
    hourlyRate: typeof body.hourlyRate === "number" ? body.hourlyRate : null,
    weeklyBudget: typeof body.weeklyBudget === "number" ? body.weeklyBudget : null,
  };
}

async function surveyFetch(
  origin: string,
  path: string,
  authorization: () => Promise<string | null>,
  body?: unknown,
): Promise<Response> {
  const token = await authorization();
  return fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
