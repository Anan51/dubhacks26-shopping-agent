import mongoose from "mongoose";

import { liftCart, sleepCart, VAULT_MS } from "../carts.js";
import { categoryForItem, getBudgetProfile } from "../purchases/service.js";
import { assertNever, type Cart, type Decision, type ScoreBucket } from "../types.js";
import { computeImpulseScore } from "./backboardScore.js";
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
): Promise<CartReading> {
  const hourlyRate = await hourlyRateFor(userId);
  const rawHours = hourlyRate != null && hourlyRate > 0 ? input.price / hourlyRate : null;
  const worked = hourlyRate != null ? hoursOfWork(input.price, hourlyRate) : null;
  const scored = await computeImpulseScore(userId ?? "", {
    item: input.item,
    category: input.category,
    price: input.price,
    necessary: input.necessary,
    hours: rawHours,
  });
  const band = impulseBand(scored.score);
  return {
    impulse: { score1to8: scored.score, band, why: scored.why },
    hoursOfWork: worked,
    hoursOfWorkText: worked ? hoursOfWorkText(worked) : null,
    legacyImpulse: legacyImpulseBase(scored.score),
  };
}

export function readingForCart(userId: string | null, cart: Cart): Promise<CartReading> {
  const item = cart.items[0]?.name ?? "Apple bag";
  return readImpulse(userId, {
    item,
    category: categoryForItem(item),
    price: cart.totalCents / 100,
    necessary: cart.necessity === "necessary",
  });
}

/**
 * Stores the 1–8 reading on the cart and, before a justification grade exists,
 * sets the legacy 1–5 base the lock math already understands.
 * Necessary buys are left unlocked. Soft stays on the marinating lock.
 */
export function applyImpulseReading(cart: Cart, reading: CartReading, now: Date, demoReminderMs: number): void {
  if (cart.decision) {
    const annotated = annotateDecision(cart.decision, reading);
    cart.decision = annotated.decision;
    cart.impulse = annotated.impulse;
    cart.hoursOfWork = annotated.hoursOfWork;
    cart.hoursOfWorkText = annotated.hoursOfWorkText;
  } else {
    cart.impulse = reading.impulse;
    cart.hoursOfWork = reading.hoursOfWork;
    cart.hoursOfWorkText = reading.hoursOfWorkText;
  }
  if (cart.purchaseScore != null) {
    return;
  }
  cart.userImpulseScore = reading.legacyImpulse;
  if (cart.necessity === "necessary") {
    return;
  }
  switch (reading.impulse.band) {
    case "free":
      liftCart(cart);
      return;
    case "soft":
      return;
    case "strict":
      sleepCart(cart, now, VAULT_MS, demoReminderMs, "enforced");
      return;
    default:
      assertNever(reading.impulse.band);
  }
}

async function hourlyRateFor(userId: string | null): Promise<number | null> {
  if (!userId || !/^[a-f0-9]{24}$/i.test(userId) || mongoose.connection.readyState !== 1) {
    return null;
  }
  const profile = await getBudgetProfile(userId);
  return profile.hourlyRate;
}
