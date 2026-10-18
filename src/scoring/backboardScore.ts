import mongoose from "mongoose";

import {
  countRegrets,
  getBudgetProfile,
  getPurchaseHistory,
  getSavedGoals,
  type BudgetProfile,
  type SavedGoal,
} from "../purchases/service.js";
import { clampImpulseScale } from "./lockBand.js";

export type ImpulseItem = {
  item: string;
  category: string;
  /** Dollars, same unit as the weekly budget and hourly rate. */
  price: number;
  necessary: boolean;
  /**
   * Raw price / hourly rate. A value strictly above 8 is a soft upward nudge.
   * Null when the shopper has no positive rate.
   */
  hours?: number | null;
};

export type ImpulseScore = {
  /** 1 very deliberate, 8 very impulsive. New shoppers are exactly 4.5. */
  score: number;
  why: string | null;
};

export type ImpulseSignals = {
  weeklyBudget: number | null;
  categoryRegrets: number;
  categoryKept: number;
  regretCount: number;
  ratedCount: number;
  goals: readonly SavedGoal[];
};

export const EMPTY_IMPULSE_SIGNALS: ImpulseSignals = {
  weeklyBudget: null,
  categoryRegrets: 0,
  categoryKept: 0,
  regretCount: 0,
  ratedCount: 0,
  goals: [],
};

const MIDPOINT = 4.5;
const CATEGORY_REGRET_STEP = 0.7;
const CATEGORY_REGRET_CAP = 2.1;
const CATEGORY_KEPT_STEP = 0.25;
const CATEGORY_KEPT_CAP = 1;
const RATIO_SPAN = 0.8;
const OVER_BUDGET_NUDGE = 0.5;
const LONG_HOURS_NUDGE = 0.4;
const GOAL_NUDGE = 0.3;

const WHY_REGRET = "You regretted a similar purchase before.";
const WHY_KEPT = "You've kept a similar purchase.";
const WHY_RATIO_UP = "More of your past buys were regrets.";
const WHY_RATIO_DOWN = "You've kept more purchases than you've regretted.";
const WHY_BUDGET = "This costs more than your weekly budget.";
const WHY_HOURS = "This is more than a day's work.";
const WHY_GOAL = "This takes a bite out of a goal you saved.";

type Note = { weight: number; why: string };

/**
 * History only moves an unnecessary buy. A necessary item stays at 4.5.
 * Empty goals are not a penalty. Example rows must already be removed by the caller.
 */
export function scoreFromSignals(input: ImpulseItem, signals: ImpulseSignals): ImpulseScore {
  if (input.necessary) {
    return { score: MIDPOINT, why: null };
  }

  let score = MIDPOINT;
  const notes: Note[] = [];

  if (signals.categoryRegrets > 0) {
    const bump = Math.min(CATEGORY_REGRET_CAP, signals.categoryRegrets * CATEGORY_REGRET_STEP);
    score += bump;
    notes.push({ weight: bump, why: WHY_REGRET });
  }

  if (signals.categoryKept > 0) {
    const drop = Math.min(CATEGORY_KEPT_CAP, signals.categoryKept * CATEGORY_KEPT_STEP);
    score -= drop;
    notes.push({ weight: drop, why: WHY_KEPT });
  }

  if (signals.ratedCount > 0 && signals.regretCount > 0) {
    const ratio = Math.min(1, signals.regretCount / signals.ratedCount);
    const nudge = (ratio - 0.5) * RATIO_SPAN;
    if (nudge > 0.05) {
      score += nudge;
      notes.push({ weight: nudge, why: WHY_RATIO_UP });
    } else if (nudge < -0.05) {
      score += nudge;
      notes.push({ weight: -nudge, why: WHY_RATIO_DOWN });
    }
  } else if (signals.ratedCount > 0 && signals.regretCount === 0) {
    const nudge = (0 - 0.5) * RATIO_SPAN;
    score += nudge;
    notes.push({ weight: -nudge, why: WHY_RATIO_DOWN });
  }

  if (signals.weeklyBudget != null && signals.weeklyBudget > 0 && input.price > signals.weeklyBudget) {
    score += OVER_BUDGET_NUDGE;
    notes.push({ weight: OVER_BUDGET_NUDGE, why: WHY_BUDGET });
  }

  if (input.hours != null && input.hours > 8) {
    score += LONG_HOURS_NUDGE;
    notes.push({ weight: LONG_HOURS_NUDGE, why: WHY_HOURS });
  }

  if (signals.goals.length > 0 && competesWithGoal(input.price, signals.goals)) {
    score += GOAL_NUDGE;
    notes.push({ weight: GOAL_NUDGE, why: WHY_GOAL });
  }

  const notable = notes.sort((left, right) => right.weight - left.weight)[0];
  return {
    score: clampImpulseScale(score),
    why: notable && notable.weight >= 0.25 ? notable.why : null,
  };
}

const HISTORY_WINDOW = 50;

/**
 * Reads budget, regrets, history, and goals. Does not write. Necessary items skip the reads.
 * Category regrets use `countRegrets`. Kept purchases and the regret ratio use the same newest-50 window.
 * Pass `budget` when the caller already loaded the profile so it is not read twice.
 */
export async function computeImpulseScore(
  userId: string,
  input: ImpulseItem,
  budget?: Pick<BudgetProfile, "weeklyBudget">,
): Promise<ImpulseScore> {
  if (input.necessary || !shopperReadable(userId)) {
    return scoreFromSignals(input, EMPTY_IMPULSE_SIGNALS);
  }
  const category = input.category.trim().toLowerCase();
  const [profile, history, categoryRegrets, goals] = await Promise.all([
    budget ? Promise.resolve(budget) : getBudgetProfile(userId),
    getPurchaseHistory(userId, HISTORY_WINDOW),
    countRegrets(userId, category),
    getSavedGoals(userId),
  ]);
  const rated = history.filter((row) => row.feedback === "regretted" || row.feedback === "kept");
  return scoreFromSignals(
    { ...input, category },
    {
      weeklyBudget: profile.weeklyBudget,
      categoryRegrets,
      categoryKept: history.filter((row) => row.category === category && row.feedback === "kept").length,
      regretCount: rated.filter((row) => row.feedback === "regretted").length,
      ratedCount: rated.length,
      goals,
    },
  );
}

function competesWithGoal(price: number, goals: readonly SavedGoal[]): boolean {
  return goals.some((goal) => goal.targetAmount != null && goal.targetAmount > 0 && price >= goal.targetAmount * 0.5);
}

function shopperReadable(userId: string): boolean {
  return /^[a-f0-9]{24}$/i.test(userId) && mongoose.connection.readyState === 1;
}
