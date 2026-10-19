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
  const style = document.createElement("style");
  style.textContent = [
    "#simmer-survey { display: flex; flex-direction: column; gap: 0.35rem; padding-bottom: 0.4rem; }",
    "#simmer-survey[hidden] { display: none; }",
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
      const completed = await reloadSurvey();
      if (completed === "unauthorized") {
        return "unauthorized";
      }
      section.hidden = completed;
      return completed;
    },
    hide() {
      section.hidden = true;
    },
  };

  async function reloadSurvey(): Promise<boolean | "unauthorized"> {
    const state = await loadSurvey(origin, authorization, onUnauthorized);
    if (state === "unauthorized") {
      return "unauthorized";
    }
    return state?.completed === true;
  }

  async function submit(): Promise<void> {
    if (save.disabled) {
      return;
    }
    save.disabled = true;
    error.hidden = true;
    let formLocked = false;
    try {
      const recentPurchases = readPurchaseRows();
      if (!recentPurchases) {
        return;
      }
      const hourlyRate = readOptionalMoney(hourly.input.value);
      const weeklyBudget = readOptionalMoney(weekly.input.value);
      if (hourlyRate === null && weeklyBudget === null && recentPurchases.length === 0) {
        showSaveError("Add an hourly rate, a weekly budget, or a recent purchase.");
        return;
      }
      const response = await authorizedFetch(
        `${origin}/onboarding/survey`,
        {
          method: "POST",
          body: {
            hourlyRate,
            weeklyBudget,
            recentPurchases,
          },
        },
        authorization,
        onUnauthorized,
      );
      if (!response) {
        return;
      }
      if (response.status === 409) {
        const completed = await reloadSurvey();
        if (completed === "unauthorized") {
          return;
        }
        if (completed) {
          formLocked = true;
          section.hidden = true;
          onComplete();
          return;
        }
        showSaveError(await completedSurveyMessage(response));
        return;
      }
      if (!response.ok) {
        showSaveError(await describeSaveFailure(response));
        return;
      }
      section.hidden = true;
      onComplete();
    } catch (caught: unknown) {
      const message = caught instanceof Error && caught.message ? caught.message : "Could not save the survey.";
      showSaveError(message);
    } finally {
      if (!formLocked) {
        save.disabled = false;
      }
    }
  }

  function readPurchaseRows(): { item: string; price: number; regretted: boolean }[] | null {
    const recentPurchases: { item: string; price: number; regretted: boolean }[] = [];
    for (const row of rows) {
      row.note.hidden = true;
      row.note.textContent = "";
      const item = row.item.value.trim();
      const rawPrice = row.price.value.trim();
      if (!item && rawPrice === "") {
        continue;
      }
      const price = readMoney(row.price.value);
      if (item && price === null) {
        row.note.hidden = false;
        row.note.textContent = "Enter a price.";
        return null;
      }
      if (!item || price === null) {
        row.note.hidden = false;
        row.note.textContent = "Enter an item and a price.";
        return null;
      }
      recentPurchases.push({ item, price, regretted: row.regretted.checked });
    }
    return recentPurchases;
  }

  function showSaveError(message: string): void {
    error.hidden = false;
    error.textContent = message;
  }
}

type PurchaseDraft = {
  item: HTMLInputElement;
  price: HTMLInputElement;
  regretted: HTMLInputElement;
  note: HTMLParagraphElement;
};

function moneyField(name: string, labelText: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.name = name;
  input.type = "text";
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
  price.type = "text";
  price.inputMode = "decimal";
  price.placeholder = "Price";
  price.setAttribute("aria-label", "Recent purchase price");
  const regretted = document.createElement("input");
  regretted.type = "checkbox";
  const regrettedLabel = document.createElement("label");
  regrettedLabel.append(regretted, document.createTextNode("Regretted"));
  const note = document.createElement("p");
  note.className = "error row-error";
  note.hidden = true;
  row.append(item, price, regrettedLabel, note);
  parent.append(row);
  return { item, price, regretted, note };
}

function readOptionalMoney(value: string): number | null {
  return readMoney(value);
}

/** Accepts 12, $12.99, and 12,99. Empty input stays unset. */
function readMoney(value: string): number | null {
  const normalized = normalizeMoney(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMoney(value: string): string {
  let text = value.trim().replace(/[$€£]/g, "").replace(/\s+/g, "");
  if (!text) {
    return "";
  }
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (comma >= 0) {
    const fraction = text.slice(comma + 1);
    text = fraction.length > 0 && fraction.length <= 2 ? text.replace(",", ".") : text.replace(/,/g, "");
  }
  return text;
}

async function completedSurveyMessage(response: Response): Promise<string> {
  const detail = await readErrorText(response);
  return detail.length > 0 ? detail : "Survey already completed.";
}

async function describeSaveFailure(response: Response): Promise<string> {
  const detail = await readErrorText(response);
  return detail.length > 0 ? `${response.status} ${detail}` : `Could not save the survey (${response.status}).`;
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && typeof body.error === "string") {
      return body.error.trim();
    }
  } catch {
    return "";
  }
  return "";
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

