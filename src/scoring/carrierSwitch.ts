import { liftCart } from "../carts.js";
import { formatUsd } from "../format.js";
import type { Cart } from "../types.js";

/**
 * Numbers read from the local carrier-switch fixture.
 * They are example data, not a Carrier X or Carrier Y quote.
 */
export type CarrierFacts = {
  currentMonthlyCents: number;
  newMonthlyCents: number;
  balanceCents: number;
  monthsLeft: number;
  feeCents: number;
};

/** Default fixture. A real balance and fee, and only a small monthly saving. */
export const CARRIER_WAIT: CarrierFacts = {
  currentMonthlyCents: 8_000,
  newMonthlyCents: 7_400,
  balanceCents: 36_000,
  monthsLeft: 12,
  feeCents: 12_000,
};

/** Pass fixture. Nothing left to pay, and the new plan costs less. */
export const CARRIER_PASS: CarrierFacts = {
  currentMonthlyCents: 8_000,
  newMonthlyCents: 5_500,
  balanceCents: 0,
  monthsLeft: 0,
  feeCents: 0,
};

export type CarrierVerdict = "wait" | "pass";

const MAX_CENTS = 10_000_000;
const MAX_MONTHS = 120;

export function monthlySavingCents(facts: CarrierFacts): number {
  return facts.currentMonthlyCents - facts.newMonthlyCents;
}

/** Balance still owed plus the early-termination fee. */
export function upfrontCents(facts: CarrierFacts): number {
  return facts.balanceCents + facts.feeCents;
}

/**
 * Months until the monthly saving covers the balance and the fee.
 * Null when the new plan is not cheaper. Zero when nothing is due up front.
 * Rounds up so a partial month still counts.
 */
export function breakEvenMonths(facts: CarrierFacts): number | null {
  const saving = monthlySavingCents(facts);
  if (saving <= 0) {
    return null;
  }
  const upfront = upfrontCents(facts);
  if (upfront <= 0) {
    return 0;
  }
  return Math.ceil(upfront / saving);
}

/** Pass only when switching costs nothing and the new plan is actually cheaper. */
export function carrierVerdict(facts: CarrierFacts): CarrierVerdict {
  if (upfrontCents(facts) === 0 && monthlySavingCents(facts) > 0) {
    return "pass";
  }
  return "wait";
}

/** Plain sentence from the page's own numbers. No invented shoppers. */
export function carrierSentence(facts: CarrierFacts): string {
  const verdict = carrierVerdict(facts);
  switch (verdict) {
    case "pass":
      return passSentence(facts);
    case "wait":
      return waitSentence(facts);
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

/**
 * The break-even sentence, then the regret line the existing impulse score already produced.
 * A null why means Backboard had nothing to add. This does not score on its own.
 */
export function carrierCardLine(facts: CarrierFacts, regretWhy: string | null): string {
  const sentence = carrierSentence(facts);
  const why = regretWhy?.trim() ?? "";
  if (!why) {
    return sentence;
  }
  return `${sentence} ${why}`;
}

/**
 * Stores the card line and opens checkout on a pass.
 * Call this after `readingForCart` so `impulse.why` is the current regret score.
 * A pass lifts a vault: nothing is owed and the plan is cheaper, so the click goes through.
 * A wait stays locked, including a vault the impulse score already opened.
 */
export function applyCarrierLine(cart: Cart, facts: CarrierFacts): void {
  const line = carrierCardLine(facts, cart.impulse?.why ?? null);
  cart.carrierLine = line;
  const verdict = carrierVerdict(facts);
  switch (verdict) {
    case "pass":
      cart.necessity = "necessary";
      cart.necessitySource = "keywords";
      cart.necessityReason = line;
      cart.scoreReason = line;
      liftCart(cart);
      return;
    case "wait":
      cart.necessity = "unnecessary";
      cart.necessitySource = cart.necessitySource ?? "keywords";
      cart.necessityReason = line;
      if (cart.purchaseScore != null || cart.status === "vault") {
        return;
      }
      cart.isUnlocked = false;
      cart.status = "locked";
      cart.scoreReason = null;
      return;
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

/** Accepts the carrier object posted with a bag. Anything else is ignored. */
export function parseCarrierFacts(value: unknown): CarrierFacts | null {
  if (!isRecord(value)) {
    return null;
  }
  const currentMonthlyCents = centsField(value.currentMonthlyCents, false);
  const newMonthlyCents = centsField(value.newMonthlyCents, false);
  const balanceCents = centsField(value.balanceCents, true);
  const feeCents = centsField(value.feeCents, true);
  const monthsLeft = monthsField(value.monthsLeft);
  if (
    currentMonthlyCents === null ||
    newMonthlyCents === null ||
    balanceCents === null ||
    feeCents === null ||
    monthsLeft === null
  ) {
    return null;
  }
  return { currentMonthlyCents, newMonthlyCents, balanceCents, monthsLeft, feeCents };
}

function passSentence(facts: CarrierFacts): string {
  const saving = formatUsd(monthlySavingCents(facts));
  return `There's no reason to wait. Nothing is left on the phone, there's no fee, and the new plan is ${saving} a month cheaper.`;
}

function waitSentence(facts: CarrierFacts): string {
  const balance = formatUsd(facts.balanceCents);
  const fee = formatUsd(facts.feeCents);
  const saving = monthlySavingCents(facts);
  if (saving <= 0) {
    return `You'd pay ${balance} left on the phone plus a ${fee} fee, and the new plan is not cheaper. Switching does not pay for itself.`;
  }
  const months = breakEvenMonths(facts);
  if (months === null || months < 1) {
    return `You'd pay ${balance} left on the phone plus a ${fee} fee to save ${formatUsd(saving)} a month.`;
  }
  const unit = months === 1 ? "month" : "months";
  const left =
    facts.monthsLeft > 0
      ? ` ${facts.monthsLeft === 1 ? "1 month is" : `${facts.monthsLeft} months are`} left on the phone.`
      : "";
  return `You'd pay ${balance} left on the phone plus a ${fee} fee to save ${formatUsd(saving)} a month. That takes ${months} ${unit} to break even.${left}`;
}

function centsField(value: unknown, allowZero: boolean): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_CENTS) {
    return null;
  }
  if (!allowZero && value <= 0) {
    return null;
  }
  return value;
}

function monthsField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_MONTHS) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
