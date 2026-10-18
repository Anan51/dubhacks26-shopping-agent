import mongoose from "mongoose";

import { sleepCart, VAULT_MS } from "../carts.js";
import { categoryForItem, getBudgetProfile, type BudgetProfile } from "../purchases/service.js";
import { type Cart, type Decision, type ScoreBucket } from "../types.js";
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
  const item = cart.items[0]?.name ?? "Apple bag";
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

export type ImpulseApply = "create" | "refresh";

/**
 * Stores the 1–8 reading on the cart.
 * An unnecessary bag is never unlocked from the score. Only a necessary buy opens without a reply.
 * `create` may vault a strict bag once. `refresh` rewrites `impulse` and `hoursOfWork` only.
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
  if (reading.impulse.band !== "strict" || cartIsEnforcedVault(cart)) {
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
