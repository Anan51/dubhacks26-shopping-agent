import { isRecord } from "../../src/record.js";
import { authorizedFetch } from "./popup-fetch.js";

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
  const section = document.createElement("section");
  section.id = "simmer-survey";
  section.className = "panel";
  section.hidden = true;
  const title = document.createElement("p");
  title.className = "card-header";
  title.textContent = "Survey";
  const heading = document.createElement("p");
  heading.className = "lede";
  heading.textContent = "A few questions before you shop";
  const hourly = moneyField("hourlyRate", "Rough hourly rate");
  const weekly = moneyField("weeklyBudget", "Rough weekly budget");
  const purchases = document.createElement("div");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn-secondary";
  add.textContent = "Add a recent purchase";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.textContent = "Save survey";
  const error = document.createElement("p");
  error.className = "error";
  error.hidden = true;
  section.append(title, heading, hourly.label, weekly.label, purchases, add, save, error);
  parent.append(section);

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
      const state = await loadSurvey(origin, authorization, onUnauthorized);
      if (state === "unauthorized") {
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
    try {
      const response = await authorizedFetch(
        `${origin}/onboarding/survey`,
        {
          method: "POST",
          body: {
            hourlyRate: readOptionalMoney(hourly.input.value),
            weeklyBudget: readOptionalMoney(weekly.input.value),
            recentPurchases,
          },
        },
        authorization,
        onUnauthorized,
      );
      if (!response) {
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
  onUnauthorized: (token: string | null) => Promise<void>,
): Promise<SurveyState | "unauthorized" | null> {
  const response = await authorizedFetch(`${origin}/onboarding/survey`, undefined, authorization, onUnauthorized);
  if (!response) {
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

