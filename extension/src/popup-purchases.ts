import { isRecord } from "../../src/record.js";
import { authorizedFetch } from "./popup-fetch.js";
import { nextPurchaseFeedback, type PurchaseFeedback } from "./purchase-feedback.js";

export type { PurchaseFeedback };

export type PurchaseRow = {
  _id: string;
  item: string;
  category: string;
  price: number;
  feedback: PurchaseFeedback;
  isExample: boolean;
  source: "survey" | "checkout";
};

export function attachPurchaseHistory(
  parent: HTMLElement,
  origin: string,
  authorization?: () => Promise<string | null>,
  onUnauthorized?: (token: string | null) => Promise<void>,
): { show(): void; hide(): void } {
  const style = document.createElement("style");
  style.textContent = [
    "#simmer-purchases { padding: 0.2rem 0 0.4rem; }",
    "#simmer-purchases ul { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }",
    "#simmer-purchases li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.4rem; align-items: center; max-width: 100%; box-sizing: border-box; background: #fffaf3; border: 1px solid #eadccb; border-radius: 0.7rem; padding: 0.4rem 0.5rem; }",
    "#simmer-purchases .title { flex: 1 1 6rem; min-width: 0; overflow-wrap: anywhere; }",
    "#simmer-purchases .votes { display: flex; flex-wrap: wrap; gap: 0.25rem; max-width: 100%; }",
    "#simmer-purchases .confirm, #simmer-purchases .row-error { flex: 1 0 100%; display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; margin: 0; max-width: 100%; }",
    "#simmer-purchases button { font: inherit; color: #3a2416; border: 1px solid #eadccb; background: #fffaf3; border-radius: 999px; padding: 0.15rem 0.4rem; cursor: pointer; max-width: 100%; }",
    "#simmer-purchases button[aria-pressed='true'] { background: #8a4b24; border-color: #8a4b24; color: #fffaf3; }",
  ].join("");
  const section = document.createElement("section");
  section.id = "simmer-purchases";
  section.hidden = true;
  const heading = document.createElement("p");
  heading.className = "kicker";
  heading.textContent = "Past purchases";
  const empty = document.createElement("p");
  empty.className = "fine";
  empty.textContent = "No purchases yet.";
  empty.hidden = true;
  const list = document.createElement("ul");
  const status = document.createElement("p");
  status.className = "error";
  status.hidden = true;
  section.append(heading, empty, list, status);
  parent.append(style, section);
  let loadId = 0;

  return {
    show() {
      section.hidden = false;
      void load();
    },
    hide() {
      section.hidden = true;
      list.replaceChildren();
      empty.hidden = true;
      status.hidden = true;
    },
  };

  async function load(): Promise<void> {
    const id = ++loadId;
    status.hidden = true;
    try {
      const response = await authorizedFetch(
        `${origin}/purchases/history?limit=15`,
        undefined,
        authorization ?? (async () => null),
        onUnauthorized ?? (async () => undefined),
      );
      if (id !== loadId || !response) {
        return;
      }
      if (!response.ok) {
        status.hidden = false;
        status.textContent = "Could not load purchases.";
        return;
      }
      const body = (await response.json()) as unknown;
      if (id !== loadId) {
        return;
      }
      const purchases = readPurchases(body);
      empty.hidden = purchases.length > 0;
      list.replaceChildren();
      for (const purchase of purchases) {
        list.append(row(purchase));
      }
    } catch {
      if (id !== loadId) {
        return;
      }
      status.hidden = false;
      status.textContent = "Could not load purchases.";
    }
  }

  function row(purchase: PurchaseRow): HTMLLIElement {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = `${purchase.item} · ${purchase.category} · ${formatPrice(purchase.price)}`;
    const votes = document.createElement("span");
    votes.className = "votes";
    votes.append(voteButton(purchase, "kept", "Thumbs up"), voteButton(purchase, "regretted", "Thumbs down"), removeButton(purchase, item));
    item.append(title, votes);
    return item;
  }

  function removeButton(purchase: PurchaseRow, item: HTMLLIElement): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "remove";
    button.textContent = "Remove";
    button.addEventListener("click", () => {
      askRemove(purchase, item);
    });
    return button;
  }

  function askRemove(purchase: PurchaseRow, item: HTMLLIElement): void {
    const existing = item.querySelector(".confirm");
    if (existing) {
      return;
    }
    const previous = item.querySelector(".row-error");
    if (previous) {
      previous.setAttribute("hidden", "");
    }
    const confirm = document.createElement("p");
    confirm.className = "confirm";
    const question = document.createElement("span");
    question.textContent = "Remove this purchase?";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = "Yes";
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = "No";
    yes.addEventListener("click", () => {
      confirm.remove();
      void removePurchase(purchase, item);
    });
    no.addEventListener("click", () => {
      confirm.remove();
    });
    confirm.append(question, yes, no);
    item.append(confirm);
  }

  async function removePurchase(purchase: PurchaseRow, item: HTMLLIElement): Promise<void> {
    const id = ++loadId;
    try {
      const response = await authorizedFetch(
        `${origin}/purchases/${purchase._id}`,
        { method: "DELETE" },
        authorization ?? (async () => null),
        onUnauthorized ?? (async () => undefined),
      );
      if (id !== loadId || !response) {
        return;
      }
      if (!response.ok) {
        showRowError(item, "Could not remove that purchase.");
        return;
      }
      item.remove();
      empty.hidden = list.childElementCount > 0;
    } catch {
      if (id !== loadId) {
        return;
      }
      showRowError(item, "Could not remove that purchase.");
    }
  }

  function showRowError(item: HTMLLIElement, message: string): void {
    let error = item.querySelector("p.row-error");
    if (!error) {
      const created = document.createElement("p");
      created.className = "error row-error";
      item.append(created);
      error = created;
    }
    error.removeAttribute("hidden");
    error.textContent = message;
  }

  function voteButton(purchase: PurchaseRow, choice: "kept" | "regretted", label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice === "kept" ? "\u{1F44D}" : "\u{1F44E}";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", purchase.feedback === choice ? "true" : "false");
    button.addEventListener("click", () => {
      void vote(purchase, choice);
    });
    return button;
  }

  async function vote(purchase: PurchaseRow, choice: "kept" | "regretted"): Promise<void> {
    status.hidden = true;
    const feedback = nextPurchaseFeedback(purchase.feedback, choice);
    try {
      const response = await authorizedFetch(
        `${origin}/purchases/${purchase._id}/feedback`,
        { method: "POST", body: { feedback } },
        authorization ?? (async () => null),
        onUnauthorized ?? (async () => undefined),
      );
      if (!response) {
        return;
      }
      if (!response.ok) {
        status.hidden = false;
        status.textContent = "Could not save that rating.";
        return;
      }
      await load();
    } catch {
      status.hidden = false;
      status.textContent = "Could not save that rating.";
    }
  }
}

function formatPrice(price: number): string {
  const cents = Math.round(price * 100) % 100;
  return price.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function readPurchases(body: unknown): PurchaseRow[] {
  if (!isRecord(body) || !Array.isArray(body.purchases)) {
    return [];
  }
  return body.purchases.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry._id !== "string" || typeof entry.item !== "string") {
      return [];
    }
    const feedback = entry.feedback === "regretted" || entry.feedback === "kept" ? entry.feedback : null;
    const source = entry.source === "survey" ? "survey" : "checkout";
    if (entry.isExample === true) {
      return [];
    }
    return [
      {
        _id: entry._id,
        item: entry.item,
        category: typeof entry.category === "string" ? entry.category : "other",
        price: typeof entry.price === "number" ? entry.price : 0,
        feedback,
        isExample: false,
        source,
      },
    ];
  });
}
