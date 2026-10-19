import { lockGlance, type GlanceItem } from "../../src/glance.js";
import { pauseSentence, priceLine } from "../../src/overlay-copy.js";
import { mountPopupAuth, type PopupAccount } from "./popup-auth.js";
import { newestAccountCart, newestCart, plainCartLabel, presentBreakdown, type ReplyPing } from "./popup-cart.js";
import { authorizedFetch } from "./popup-fetch.js";

type CartPayload = {
  code: string;
  userId: string | null;
  createdAt?: string;
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
  replied?: boolean;
  advice?: string | null;
  lastPing?: ReplyPing;
  authUserId?: string | null;
};

type CartScope =
  | { kind: "device"; userId: string }
  | { kind: "account"; account: PopupAccount };

const state = document.getElementById("state");
const list = document.getElementById("list");
const empty = document.getElementById("empty");
let openCode: string | null = null;
let shown = 0;

chrome.storage.local.get(["simmerOrigin", "simmerUserId", "simmerAuthOrigin", "simmer_token"], (stored) => {
  const origin = allowedOrigin(stored.simmerOrigin) ?? "http://127.0.0.1:4321";
  const userId = typeof stored.simmerUserId === "string" ? stored.simmerUserId : "";
  const token = typeof stored.simmer_token === "string" ? stored.simmer_token : "";
  let signedIn = false;
  if (token.length === 0) {
    void load(origin, { kind: "device", userId });
  }
  mountPopupAuth(document.body, stored.simmerAuthOrigin, {
    onAuthChange(account) {
      if (!account) {
        if (signedIn) {
          signedIn = false;
          clearVault();
          return;
        }
        // A stored token was rejected before sign-in. Show the same device list as an empty token.
        void load(origin, { kind: "device", userId });
        return;
      }
      signedIn = true;
      void load(origin, { kind: "account", account });
    },
  });
});

async function load(origin: string, scope: CartScope): Promise<void> {
  const ticket = ++shown;
  const response = await fetchCarts(origin, scope);
  if (ticket !== shown || !response) {
    return;
  }
  const body = (await response.json()) as { carts?: CartPayload[] };
  if (ticket !== shown) {
    return;
  }
  render(selectCart(body.carts ?? [], scope));
}

function clearVault(): void {
  shown += 1;
  openCode = null;
  render(null);
}

function render(current: CartPayload | null): void {
  const items = current ? [toGlance(current)] : [];
  if (state) {
    state.textContent = lockGlance(items);
  }
  if (!list || !empty) {
    return;
  }
  list.replaceChildren();
  empty.hidden = items.length > 0;
  for (const item of items) {
    list.append(card(item, current?.lastPing ?? null));
  }
}

function selectCart(carts: readonly CartPayload[], scope: CartScope): CartPayload | null {
  switch (scope.kind) {
    case "device":
      return newestCart(carts, scope.userId);
    case "account":
      return newestAccountCart(carts, scope.account.id);
    default: {
      const unreachable: never = scope;
      return unreachable;
    }
  }
}

async function fetchCarts(origin: string, scope: CartScope): Promise<Response | null> {
  switch (scope.kind) {
    case "device":
      return fetch(`${origin}/api/carts`, { headers: { accept: "application/json" } });
    case "account":
      return authorizedFetch(`${origin}/api/carts`, undefined, async () => scope.account.token, async () => {
        clearVault();
      });
    default: {
      const unreachable: never = scope;
      return unreachable;
    }
  }
}

function card(item: GlanceItem, lastPing: ReplyPing): HTMLLIElement {
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
  line.textContent = plainCartLabel({ ...item, lastPing }, Date.now());
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

function breakdown(item: GlanceItem): HTMLDivElement {
  const wrap = document.createElement("div");
  const detail = presentBreakdown(item, Date.now());
  const dl = document.createElement("dl");
  const price = priceLine(item.priceCents, { cents: item.decision?.costLaterCents ?? 0, example: true });
  const lines = [
    { label: "Why", value: pauseSentence(item) },
    { label: "Price", value: price },
  ];
  for (const line of lines) {
    const term = document.createElement("dt");
    term.textContent = line.label;
    const value = document.createElement("dd");
    value.textContent = line.value;
    dl.append(term, value);
  }
  wrap.append(dl);
  if (detail.exampleNote && /example|If you wait/i.test(price)) {
    const note = document.createElement("p");
    note.className = "fine";
    note.textContent = detail.exampleNote;
    wrap.append(note);
  }
  return wrap;
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
    replied: cart.replied === true,
    advice: cart.advice ?? null,
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
