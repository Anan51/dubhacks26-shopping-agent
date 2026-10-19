import mongoose from "mongoose";

import { PAUSE_FLOOR_CENTS, sleepCart, VAULT_MS } from "../carts.js";
import { keywordNecessity } from "../impulse.js";
import { categoryForItem, getBudgetProfile, type BudgetProfile } from "../purchases/service.js";
import { type Cart, type CartItem, type Decision, type ScoreBucket } from "../types.js";
import { computeImpulseScore, type ImpulseScoreOptions } from "./backboardScore.js";
import { hoursOfWork, hoursOfWorkText, type HoursOfWork } from "./hoursOfWork.js";
import { impulseBand, legacyImpulseBase } from "./lockBand.js";

export type ImpulseField = {
  score1to8: number;
  band: ScoreBucket;
  why: string | null;
};

export type CartReading = {
  impulse: ImpulseField;
  hoursOfWork: HoursOfWork | null;
  hoursOfWorkText: string | null;
  legacyImpulse: number;
};

export type AnnotatedDecision<T extends Decision> = {
  decision: T;
  impulse: ImpulseField;
  hoursOfWork: HoursOfWork | null;
  hoursOfWorkText: string | null;
};

/**
 * Calls `decide` upstream and returns that same decision object beside the new fields.
 * The decision value is not rewritten.
 */
export function annotateDecision<T extends Decision>(decision: T, reading: CartReading): AnnotatedDecision<T> {
  return {
    decision,
    impulse: reading.impulse,
    hoursOfWork: reading.hoursOfWork,
    hoursOfWorkText: reading.hoursOfWorkText,
  };
}

export async function readImpulse(
  userId: string | null,
  input: { item: string; category: string; price: number; necessary: boolean },
  options?: ImpulseScoreOptions,
): Promise<CartReading> {
  const profile = await budgetFor(userId);
  const hourlyRate = profile?.hourlyRate ?? null;
  const rawHours = hourlyRate != null && hourlyRate > 0 ? input.price / hourlyRate : null;
  const worked = hourlyRate != null ? hoursOfWork(input.price, hourlyRate) : null;
  const scored = await computeImpulseScore(
    userId ?? "",
    {
      item: input.item,
      category: input.category,
      price: input.price,
      necessary: input.necessary,
      hours: rawHours,
    },
    profile ?? undefined,
    options,
  );
  const band = impulseBand(scored.score);
  return {
    impulse: { score1to8: scored.score, band, why: scored.why },
    hoursOfWork: worked,
    hoursOfWorkText: worked ? hoursOfWorkText(worked) : null,
    legacyImpulse: legacyImpulseBase(scored.score),
  };
}

export function readingForCart(
  userId: string | null,
  cart: Cart,
  options?: ImpulseScoreOptions,
): Promise<CartReading> {
  const item = scoredItemName(cart);
  return readImpulse(
    userId,
    {
      item,
      category: categoryForItem(item),
      price: cart.totalCents / 100,
      necessary: cart.necessity === "necessary",
    },
    options,
  );
}

/**
 * The line whose name drives the impulse category.
 * Two or more positive cent prices are real per-item prices: the priciest item
 * `keywordNecessity` does not call necessary, or the priciest line when every
 * priced item is necessary.
 * One positive price is the itemsForBag shape (the bag total sits on a single
 * line and the rest are 0). Missing prices use that same path. Choose by name:
 * the first non-blank item `keywordNecessity` does not call necessary. A phone
 * in that set wins, so a later iPhone is scored instead of the line that
 * happens to hold the total. The last resort is the first line.
 */
function scoredItemName(cart: Cart): string {
  const fallback = cart.items[0]?.name ?? "Apple bag";
  if (positivePriceCount(cart.items) >= 2) {
    return pricedScoreName(cart.items) ?? fallback;
  }
  return namedScoreName(cart.items) ?? fallback;
}

/** The item a mixed bag is about. The Photon ask uses the same line as the score. */
export function mainItemName(cart: Cart): string {
  return scoredItemName(cart);
}

function positivePriceCount(items: readonly CartItem[]): number {
  let count = 0;
  for (const item of items) {
    const cents = integerCents(item.priceCents);
    if (cents != null && cents > 0) {
      count += 1;
    }
  }
  return count;
}

/** Priciest unnecessary line, or the priciest line when every priced item is necessary. */
function pricedScoreName(items: readonly CartItem[]): string | null {
  const priced = items.filter((item) => integerCents(item.priceCents) != null);
  if (priced.length === 0) {
    return null;
  }
  const unnecessary = priced.filter((item) => necessityOf(item.name) === false);
  return priciest(unnecessary.length > 0 ? unnecessary : priced)?.name ?? null;
}

/**
 * First unnecessary phone, otherwise the first unnecessary non-blank name.
 * Prices are ignored: a 0 line is not cheaper, and the line carrying the bag
 * total is not the purchase.
 */
function namedScoreName(items: readonly CartItem[]): string | null {
  const unnecessary = items.filter((item) => necessityOf(item.name) === false);
  const phone = unnecessary.find((item) => categoryForItem(item.name) === "phone");
  return (phone ?? unnecessary[0])?.name ?? null;
}

/** Null when the name is blank, so there is nothing for the keyword check to read. */
function necessityOf(name: string): boolean | null {
  if (name.trim().length === 0) {
    return null;
  }
  return keywordNecessity(name).necessary;
}

function integerCents(value: number): number | null {
  if (!Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function priciest(items: readonly CartItem[]): CartItem | null {
  let best: CartItem | null = null;
  for (const item of items) {
    if (best == null || item.priceCents > best.priceCents) {
      best = item;
    }
  }
  return best;
}

export type ImpulseApply = "create" | "refresh";

/**
 * Stores the 1–8 reading on the cart.
 * An unnecessary bag is never unlocked from the score. Only a necessary buy opens without a reply.
 * `create` may vault a strict bag once. A bag under `PAUSE_FLOOR_CENTS` is not vaulted.
 * `refresh` rewrites `impulse` and `hoursOfWork` only.
 */
export function applyImpulseReading(
  cart: Cart,
  reading: CartReading,
  now: Date,
  demoReminderMs: number,
  mode: ImpulseApply = "create",
): void {
  cart.impulse = reading.impulse;
  cart.hoursOfWork = reading.hoursOfWork;
  cart.hoursOfWorkText = reading.hoursOfWorkText;
  if (mode === "refresh" || cart.purchaseScore != null || cart.necessity === "necessary") {
    return;
  }
  cart.userImpulseScore = reading.legacyImpulse;
  if (cart.totalCents < PAUSE_FLOOR_CENTS || reading.impulse.band !== "strict" || cartIsEnforcedVault(cart)) {
    return;
  }
  sleepCart(cart, now, VAULT_MS, demoReminderMs, "enforced");
}

function cartIsEnforcedVault(cart: Cart): boolean {
  return cart.status === "vault" && cart.vaultMode === "enforced" && cart.vaultUntil != null;
}

async function budgetFor(userId: string | null): Promise<BudgetProfile | null> {
  if (!userId || !/^[a-f0-9]{24}$/i.test(userId) || mongoose.connection.readyState !== 1) {
    return null;
  }
  return getBudgetProfile(userId);
}
