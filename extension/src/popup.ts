import { lockGlance, oneLineVerdict, type GlanceItem } from "../../src/glance.js";
import { pauseSentence, priceLine } from "../../src/overlay-copy.js";
import { mountPopupAuth } from "./popup-auth.js";

type CartPayload = {
  code: string;
  userId: string | null;
  status: GlanceItem["status"];
  totalCents: number;
  vaultUntil: string | null;
  items: { name: string }[];
  decision: GlanceItem["decision"];
  signals: GlanceItem["signals"];
  motiveSources: GlanceItem["motiveSources"];
  necessity?: GlanceItem["necessity"];
  necessitySource?: GlanceItem["necessitySource"];
  necessityReason?: GlanceItem["necessityReason"];
  userImpulseScore?: GlanceItem["userImpulseScore"];
  justificationGrade?: GlanceItem["justificationGrade"];
  gradeSource?: GlanceItem["gradeSource"];
  gradeReason?: GlanceItem["gradeReason"];
  purchaseScore?: GlanceItem["purchaseScore"];
  scoreBucket?: GlanceItem["scoreBucket"];
  scoreReason?: GlanceItem["scoreReason"];
};

const state = document.getElementById("state");
const list = document.getElementById("list");
const empty = document.getElementById("empty");
let openCode: string | null = null;

chrome.storage.local.get(["simmerOrigin", "simmerUserId", "simmerAuthOrigin"], (stored) => {
  const origin = allowedOrigin(stored.simmerOrigin) ?? "http://127.0.0.1:4321";
  const userId = typeof stored.simmerUserId === "string" ? stored.simmerUserId : "";
  void load(origin, userId);
  if (typeof stored.simmerAuthOrigin === "string" && stored.simmerAuthOrigin.trim().length > 0) {
    mountPopupAuth(document.body, stored.simmerAuthOrigin);
  }
});

async function load(origin: string, userId: string): Promise<void> {
  const response = await fetch(`${origin}/api/carts`, { headers: { accept: "application/json" } });
  const body = (await response.json()) as { carts?: CartPayload[] };
  const carts = (body.carts ?? []).filter((cart) => !userId || cart.userId === userId);
  const items = carts.map(toGlance);
  if (state) {
    state.textContent = lockGlance(items);
  }
  if (!list || !empty) {
    return;
  }
  list.replaceChildren();
  empty.hidden = items.length > 0;
  for (const item of items) {
    list.append(card(item));
  }
}

function card(item: GlanceItem): HTMLLIElement {
  const row = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card";
  button.setAttribute("aria-expanded", "false");
  const title = document.createElement("strong");
  title.textContent = item.name;
  const price = document.createElement("span");
  price.textContent = ` · ${dollars(item.priceCents)}`;
  const line = document.createElement("div");
  line.className = "line";
  line.textContent = oneLineVerdict(item, Date.now());
  button.append(title, price, line);
  const detail = document.createElement("div");
  detail.hidden = true;
  button.addEventListener("click", () => {
    const open = openCode === item.code;
    openCode = open ? null : item.code;
    detail.hidden = open;
    button.setAttribute("aria-expanded", open ? "false" : "true");
    if (!open) {
      detail.replaceChildren(breakdown(item));
    }
  });
  row.append(button, detail);
  return row;
}

function breakdown(item: GlanceItem): HTMLDListElement {
  const dl = document.createElement("dl");
  const lines = [
    { label: "Why", value: pauseSentence(item) },
    { label: "Price", value: priceLine(item.priceCents, { cents: item.decision?.costLaterCents ?? 0, example: true }) },
  ];
  for (const line of lines) {
    const term = document.createElement("dt");
    term.textContent = line.label;
    const value = document.createElement("dd");
    value.textContent = line.value;
    dl.append(term, value);
  }
  return dl;
}

function toGlance(cart: CartPayload): GlanceItem {
  return {
    code: cart.code,
    name: cart.items[0]?.name ?? "Apple bag",
    priceCents: cart.totalCents,
    status: cart.status,
    vaultUntil: cart.vaultUntil,
    decision: cart.decision,
    signals: cart.signals ?? {},
    motiveSources: cart.motiveSources,
    necessity: cart.necessity ?? null,
    necessitySource: cart.necessitySource ?? null,
    necessityReason: cart.necessityReason ?? null,
    userImpulseScore: cart.userImpulseScore ?? null,
    justificationGrade: cart.justificationGrade ?? null,
    gradeSource: cart.gradeSource ?? null,
    gradeReason: cart.gradeReason ?? null,
    purchaseScore: cart.purchaseScore ?? null,
    scoreBucket: cart.scoreBucket ?? null,
    scoreReason: cart.scoreReason ?? null,
  };
}

function dollars(cents: number): string {
  const amount = Math.round(cents / 100);
  return `$${amount.toLocaleString("en-US")}`;
}

function allowedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return null;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
