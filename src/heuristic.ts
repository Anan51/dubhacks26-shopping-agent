import { EXAMPLE_OFFERS, type ExampleOffer } from "./offers.js";
import { assertNever, type Condition, type Decision, type SignalEffect, type Signals, type VerdictAction } from "./types.js";

/** Synthetic installment used only for the payoff side of the comparison. */
export const MONTHLY_PAYMENT_CENTS = 3_500;

/** Example age when the shopper has not named one. */
export const EXAMPLE_DEVICE_AGE_MONTHS = 24;

/** Example remaining balance: twelve $35 payments. Not a carrier balance. */
export const EXAMPLE_OWED_CENTS = 42_000;

const MAX_WAIT_MONTHS = 12;

type Quote = {
  savingsCents: number;
  costLaterCents: number;
  tradeInLaterCents: number;
  financingLaterCents: number;
};

const CONDITION_FACTOR: Record<Condition, number> = {
  fine: 1,
  minor: 0.85,
  broken: 0.45,
  unusable: 0.15,
};

const TRADE_IN_ANCHORS: readonly { months: number; cents: number }[] = [
  { months: 0, cents: 42_000 },
  { months: 12, cents: 28_000 },
  { months: 24, cents: 16_000 },
  { months: 36, cents: 8_000 },
  { months: 48, cents: 3_500 },
  { months: 72, cents: 1_500 },
];

/**
 * Cost now versus cost later, then example offers, then the shopper's motive.
 * This function does not read chat text. It only sees `Signals` and the example catalog.
 *
 * Precedence:
 * 1. need + a broken current phone + high urgency unlocks now, even when waiting saves money.
 * 2. A want with low urgency sleeps, even when waiting does not save money.
 * 3. Otherwise the best of trade-in/financing and the example offer catalog.
 *    An example offer can sleep the call when its window beats buying now.
 *    Those offers are synthetic. They are not live carrier deals.
 */
export function decide(signals: Signals): Decision {
  const newDeviceCents = signals.phonePriceCents;
  const tradeInNowCents = tradeInValueCents(signals.deviceAgeMonths, signals.condition);
  const financingNowCents = Math.max(0, signals.owedCents);
  const costNowCents = newDeviceCents + financingNowCents - tradeInNowCents;
  let bestMonths = 0;
  let bestSavings = 0;
  let best = quoteAt(signals, newDeviceCents, costNowCents, financingNowCents, 0);
  for (let month = 1; month <= MAX_WAIT_MONTHS; month += 1) {
    const quote = quoteAt(signals, newDeviceCents, costNowCents, financingNowCents, month);
    if (quote.savingsCents > bestSavings) {
      bestSavings = quote.savingsCents;
      bestMonths = month;
      best = quote;
    }
  }
  const financingAction: VerdictAction = bestSavings > 0 ? "sleep" : "unlock";
  const offerPick = bestExampleOffer(signals, newDeviceCents, costNowCents, financingNowCents, bestSavings);
  const moneySleep = offerPick !== null || financingAction === "sleep";
  const mathAction: VerdictAction = moneySleep ? "sleep" : "unlock";
  const effect = motiveEffect(signals);
  const action = applyEffect(mathAction, effect);
  const moneyMonths = offerPick?.offer.monthsFromNow ?? (financingAction === "sleep" ? bestMonths : 0);
  const moneySavings = offerPick?.netSavingsCents ?? (financingAction === "sleep" ? bestSavings : best.savingsCents);
  const moneyQuote = offerPick?.quote ?? best;
  const showMoneyWait = action === "sleep" && moneyMonths > 0;
  return {
    action,
    financingAction,
    financingSavingsCents: financingAction === "sleep" ? bestSavings : best.savingsCents,
    mathAction,
    mathWaitMonths: moneyMonths,
    mathSavingsCents: moneySavings,
    signalEffect: effect,
    offerId: offerPick?.offer.id ?? null,
    offerName: offerPick?.offer.name ?? null,
    offerSavingCents: offerPick?.offer.savingCents ?? 0,
    offerMonthsFromNow: offerPick?.offer.monthsFromNow ?? 0,
    waitMonths: action === "sleep" ? (moneyMonths > 0 ? moneyMonths : 1) : 0,
    savingsCents: moneySavings,
    costNowCents,
    costLaterCents: showMoneyWait ? moneyQuote.costLaterCents - (offerPick?.offer.savingCents ?? 0) : costNowCents,
    tradeInNowCents,
    tradeInLaterCents: showMoneyWait ? moneyQuote.tradeInLaterCents : tradeInNowCents,
    financingNowCents,
    financingLaterCents: showMoneyWait ? moneyQuote.financingLaterCents : financingNowCents,
    newDeviceCents,
    tradeInCurve: tradeInCurve(signals.deviceAgeMonths, signals.condition, MAX_WAIT_MONTHS),
  };
}

function bestExampleOffer(
  signals: Signals,
  newDeviceCents: number,
  costNowCents: number,
  financingNowCents: number,
  financingSavingsCents: number,
): { offer: ExampleOffer; netSavingsCents: number; quote: Quote } | null {
  let picked: { offer: ExampleOffer; netSavingsCents: number; quote: Quote } | null = null;
  for (const offer of EXAMPLE_OFFERS) {
    if (offer.monthsFromNow < 1 || offer.monthsFromNow > MAX_WAIT_MONTHS) {
      continue;
    }
    const quote = quoteAt(signals, newDeviceCents, costNowCents, financingNowCents, offer.monthsFromNow);
    const netSavingsCents = quote.savingsCents + offer.savingCents;
    if (netSavingsCents <= financingSavingsCents || netSavingsCents <= 0) {
      continue;
    }
    if (!picked || netSavingsCents > picked.netSavingsCents) {
      picked = { offer, netSavingsCents, quote };
    }
  }
  return picked;
}

function motiveEffect(signals: Signals): SignalEffect {
  if (signals.needVsWant === "need" && signals.currentPhoneBroken && signals.urgency === "high") {
    return "need_unlock";
  }
  if (signals.needVsWant === "want" && signals.urgency === "low") {
    return "want_sleep";
  }
  return "math";
}

function applyEffect(mathAction: VerdictAction, effect: SignalEffect): VerdictAction {
  switch (effect) {
    case "need_unlock":
      return "unlock";
    case "want_sleep":
      return "sleep";
    case "math":
      return mathAction;
    default:
      return assertNever(effect);
  }
}

export function tradeInCurve(ageMonths: number, condition: Condition, span: number): { month: number; cents: number }[] {
  const points: { month: number; cents: number }[] = [];
  for (let month = 0; month <= span; month += 1) {
    points.push({ month, cents: tradeInValueCents(ageMonths + month, condition) });
  }
  return points;
}

/** Synthetic trade-in for a phone of this age and condition, in cents. Example data, not a carrier quote. */
export function tradeInValueCents(ageMonths: number, condition: Condition): number {
  const fine = fineTradeInCents(Math.max(0, ageMonths));
  return Math.round(fine * CONDITION_FACTOR[condition]);
}

function quoteAt(
  signals: Signals,
  newDeviceCents: number,
  costNowCents: number,
  financingNowCents: number,
  month: number,
): Quote {
  const financingLaterCents = Math.max(0, financingNowCents - MONTHLY_PAYMENT_CENTS * month);
  const tradeInLaterCents = tradeInValueCents(signals.deviceAgeMonths + month, signals.condition);
  const costLaterCents = newDeviceCents + financingLaterCents - tradeInLaterCents;
  return {
    savingsCents: costNowCents - costLaterCents,
    costLaterCents,
    tradeInLaterCents,
    financingLaterCents,
  };
}

function fineTradeInCents(ageMonths: number): number {
  const first = TRADE_IN_ANCHORS[0];
  if (!first) {
    throw new Error("Trade-in curve is empty.");
  }
  if (ageMonths <= first.months) {
    return first.cents;
  }
  for (let index = 1; index < TRADE_IN_ANCHORS.length; index += 1) {
    const left = TRADE_IN_ANCHORS[index - 1];
    const right = TRADE_IN_ANCHORS[index];
    if (!left || !right) {
      break;
    }
    if (ageMonths <= right.months) {
      const span = right.months - left.months;
      const progress = (ageMonths - left.months) / span;
      return left.cents + (right.cents - left.cents) * progress;
    }
  }
  const last = TRADE_IN_ANCHORS[TRADE_IN_ANCHORS.length - 1];
  if (!last) {
    throw new Error("Trade-in curve is empty.");
  }
  return last.cents;
}
