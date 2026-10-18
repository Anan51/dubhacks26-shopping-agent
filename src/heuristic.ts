import { ALTERNATIVES, type Alternative } from "./alternatives.js";
import type { Condition, Decision, ReasonCode, Signals } from "./types.js";

/** Months we look ahead when comparing "buy today" with "keep paying the old phone". */
export const HORIZON_MONTHS = 6;

/** Synthetic installment used only for the payoff side of the comparison. */
export const MONTHLY_PAYMENT_CENTS = 3_500;

const UPSIDE_DOWN_CENTS = 10_000;
const SAVINGS_WORTH_WAITING_CENTS = 5_000;
const YOUNG_PHONE_MONTHS = 24;

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
 * Deterministic buy-or-wait call.
 * Inputs are structured signals. This function does not read chat text.
 */
export function decide(signals: Signals): Decision {
  const math = project(signals);
  if (signals.condition !== "unusable") {
    const alternative = coveringAlternative(signals);
    if (alternative) {
      return { action: "better", alternativeId: alternative.id, reasons: ["better-option"], ...math };
    }
  }
  const affordable = math.netNowCents <= signals.budgetCents;
  const reasons: ReasonCode[] = [];
  let action: "buy" | "wait" = "wait";

  if (signals.condition === "unusable" && affordable) {
    action = "buy";
    reasons.push("unusable-phone");
  } else if (!affordable) {
    reasons.push("over-budget");
    if (signals.condition === "unusable") {
      reasons.push("unusable-phone");
    }
  } else if (
    (signals.condition === "fine" || signals.condition === "minor") &&
    signals.deviceAgeMonths < YOUNG_PHONE_MONTHS
  ) {
    reasons.push("young-and-working");
  } else if (math.upsideDownCents > UPSIDE_DOWN_CENTS) {
    reasons.push("upside-down");
  } else if (math.paydownCents - math.tradeInDecayCents >= SAVINGS_WORTH_WAITING_CENTS) {
    reasons.push("waiting-saves-money");
  } else if (signals.condition === "broken" && signals.deviceAgeMonths >= YOUNG_PHONE_MONTHS) {
    action = "buy";
    reasons.push("old-and-failing");
  } else {
    reasons.push("default-wait");
  }

  return { action, alternativeId: null, reasons, ...math };
}

function coveringAlternative(signals: Signals): Alternative | null {
  if (signals.problems.length === 0) {
    return null;
  }
  const fits = ALTERNATIVES.filter((alternative) => {
    if (alternative.priceCents >= signals.dueTodayCents) {
      return false;
    }
    return signals.problems.every((tag) => alternative.solves.includes(tag));
  });
  fits.sort((left, right) => left.priceCents - right.priceCents || left.id.localeCompare(right.id));
  return fits[0] ?? null;
}

/** Synthetic trade-in for a phone of this age and condition, in cents. */
export function tradeInValueCents(ageMonths: number, condition: Condition): number {
  const fine = fineTradeInCents(Math.max(0, ageMonths));
  return Math.round(fine * CONDITION_FACTOR[condition]);
}

function project(signals: Signals): Omit<Decision, "action" | "alternativeId" | "reasons"> {
  const tradeInNowCents = tradeInValueCents(signals.deviceAgeMonths, signals.condition);
  const tradeInLaterCents = tradeInValueCents(signals.deviceAgeMonths + HORIZON_MONTHS, signals.condition);
  const owedNowCents = Math.max(0, signals.owedCents);
  const owedLaterCents = Math.max(0, owedNowCents - MONTHLY_PAYMENT_CENTS * HORIZON_MONTHS);
  const paydownCents = owedNowCents - owedLaterCents;
  const tradeInDecayCents = tradeInNowCents - tradeInLaterCents;
  const netNowCents = signals.dueTodayCents + owedNowCents - tradeInNowCents;
  const netLaterCents = signals.dueTodayCents + owedLaterCents - tradeInLaterCents;
  const upsideDownCents = Math.max(0, owedNowCents - tradeInNowCents);
  return {
    horizonMonths: HORIZON_MONTHS,
    netNowCents,
    netLaterCents,
    tradeInNowCents,
    tradeInLaterCents,
    owedNowCents,
    owedLaterCents,
    paydownCents,
    tradeInDecayCents,
    upsideDownCents,
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
