import { isRecord } from "../../src/record.js";
import { nextPurchaseFeedback, purchaseHistoryBanner, type PurchaseFeedback } from "./purchase-feedback.js";

export type { PurchaseFeedback };

export type PurchaseRow = {
  _id: string;
  item: string;
  category: string;
  price: number;
  feedback: PurchaseFeedback;
  isExample: boolean;
};

export function attachPurchaseHistory(parent: HTMLElement, origin: string): { show(): void; hide(): void } {
  const style = document.createElement("style");
  style.textContent = [
    "#simmer-purchases { padding: 0.2rem 0 0.4rem; }",
    "#simmer-purchases ul { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }",
    "#simmer-purchases li { display: flex; justify-content: space-between; gap: 0.4rem; align-items: center; background: #fffaf3; border: 1px solid #eadccb; border-radius: 0.7rem; padding: 0.4rem 0.5rem; }",
    "#simmer-purchases .example { color: #8a4b24; font-size: 0.72rem; }",
    "#simmer-purchases .votes { display: flex; gap: 0.25rem; }",
    "#simmer-purchases button { font: inherit; border: 1px solid #eadccb; background: #fffaf3; border-radius: 999px; padding: 0.15rem 0.4rem; cursor: pointer; }",
    "#simmer-purchases button[aria-pressed='true'] { background: #8a4b24; border-color: #8a4b24; }",
  ].join("");
  const section = document.createElement("section");
  section.id = "simmer-purchases";
  section.hidden = true;
  const heading = document.createElement("p");
  heading.className = "kicker";
  heading.textContent = "Recent purchases";
  const banner = document.createElement("p");
  banner.className = "fine";
  banner.hidden = true;
  const list = document.createElement("ul");
  const status = document.createElement("p");
  status.className = "error";
  status.hidden = true;
  section.append(heading, banner, list, status);
  parent.append(style, section);

  return {
    show() {
      section.hidden = false;
      void load();
    },
    hide() {
      section.hidden = true;
      list.replaceChildren();
      banner.hidden = true;
      status.hidden = true;
    },
  };

  async function load(): Promise<void> {
    status.hidden = true;
    try {
      const response = await fetch(`${origin}/purchases/history?limit=15`, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        status.hidden = false;
        status.textContent = "Could not load purchases.";
        return;
      }
      const body = (await response.json()) as unknown;
      const purchases = readPurchases(body);
      const note = purchaseHistoryBanner(purchases);
      banner.hidden = note === null;
      banner.textContent = note ?? "";
      list.replaceChildren();
      for (const purchase of purchases) {
        list.append(row(purchase));
      }
    } catch {
      status.hidden = false;
      status.textContent = "Could not load purchases.";
    }
  }

  function row(purchase: PurchaseRow): HTMLLIElement {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.textContent = `${purchase.item} · ${purchase.category} · ${formatPrice(purchase.price)}`;
    if (purchase.isExample) {
      const label = document.createElement("span");
      label.className = "example";
      label.textContent = "Example data";
      title.append(" ", label);
    }
    const votes = document.createElement("span");
    votes.className = "votes";
    votes.append(voteButton(purchase, "kept", "Thumbs up"), voteButton(purchase, "regretted", "Thumbs down"));
    item.append(title, votes);
    return item;
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
      const response = await fetch(`${origin}/purchases/${purchase._id}/feedback`, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
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
    return [
      {
        _id: entry._id,
        item: entry.item,
        category: typeof entry.category === "string" ? entry.category : "other",
        price: typeof entry.price === "number" ? entry.price : 0,
        feedback,
        isExample: entry.isExample === true,
      },
    ];
  });
}
