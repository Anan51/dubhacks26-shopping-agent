import mongoose, { type ClientSession } from "mongoose";

import type { AccountDirectory } from "../auth/accounts.js";
import { User } from "../auth/user.js";
import type { BackboardClient } from "../memory/backboard.js";
import { isRecord } from "../record.js";
import { PurchaseRecord } from "../purchases/model.js";
import {
  budgetMemoryLine,
  categoryForItem,
  getBudgetProfile,
  insertRealPurchase,
  purchaseVoteLine,
  surveyWasCompleted,
  writeUserMemoryLine,
  type BudgetProfile,
  type PurchaseView,
} from "../purchases/service.js";

export class SurveyError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SurveyError";
    this.status = status;
  }
}

export type SurveyView = {
  completed: boolean;
  hourlyRate: number | null;
  weeklyBudget: number | null;
};

export type SurveyPurchaseInput = {
  item: string;
  price: number;
  regretted: boolean;
};

const MONEY_CAP = 10_000_000;
const EMPTY_SURVEY_MESSAGE = "Add an hourly rate, a weekly budget, or a recent purchase.";

export async function readSurvey(userId: string): Promise<SurveyView> {
  const [completed, profile] = await Promise.all([surveyWasCompleted(userId), getBudgetProfile(userId)]);
  return {
    completed,
    hourlyRate: profile.hourlyRate,
    weeklyBudget: profile.weeklyBudget,
  };
}

export async function submitSurvey(
  userId: string,
  body: unknown,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<SurveyView & { purchases: PurchaseView[] }> {
  const parsed = parseSurvey(body);
  if (await surveyWasCompleted(userId)) {
    throw new SurveyError(409, "Survey already completed.");
  }
  const session = await mongoose.startSession();
  let purchases: PurchaseView[] = [];
  try {
    await session.withTransaction(async () => {
      purchases = [];
      const existing = await User.findById(userId).session(session);
      if (!existing) {
        throw new SurveyError(404, "User not found.");
      }
      if (isSurveySavedAt(existing.get("surveySavedAt")) || (await surveyHasSavedData(userId, existing, session))) {
        throw new SurveyError(409, "Survey already completed.");
      }
      if (!surveySubmissionHasData(parsed)) {
        throw new SurveyError(400, EMPTY_SURVEY_MESSAGE);
      }
      await claimSurveySave(userId, parsed, session);
      for (const purchase of parsed.recentPurchases) {
        purchases.push(
          await insertRealPurchase(
            {
              userId,
              item: purchase.item,
              category: categoryForItem(purchase.item),
              price: purchase.price,
              verdict: null,
              feedback: purchase.regretted ? "regretted" : "kept",
              source: "survey",
            },
            { session },
          ),
        );
      }
    });
  } finally {
    await session.endSession();
  }
  await rememberSurvey(userId, parsed, purchases, deps);
  return {
    completed: true,
    hourlyRate: parsed.hourlyRate,
    weeklyBudget: parsed.weeklyBudget,
    purchases,
  };
}

type ParsedSurvey = { hourlyRate: number | null; weeklyBudget: number | null; recentPurchases: SurveyPurchaseInput[] };

/** One real save stamps `surveySavedAt`. A legacy flag with no data and no stamp still matches. */
async function claimSurveySave(userId: string, parsed: ParsedSurvey, session: ClientSession): Promise<void> {
  const claimed = await User.updateOne(
    { _id: userId, surveySavedAt: null },
    {
      $set: { hourlyRate: parsed.hourlyRate, weeklyBudget: parsed.weeklyBudget, surveyCompleted: true },
      $currentDate: { surveySavedAt: true },
    },
    { session },
  );
  if (claimed.matchedCount !== 1) {
    throw new SurveyError(409, "Survey already completed.");
  }
}

function isSurveySavedAt(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function surveySubmissionHasData(parsed: ParsedSurvey): boolean {
  return parsed.hourlyRate !== null || parsed.weeklyBudget !== null || parsed.recentPurchases.length > 0;
}

/** Hourly rate, weekly budget, or at least one purchase stored with source "survey". */
async function surveyHasSavedData(
  userId: string,
  user: { hourlyRate?: unknown; weeklyBudget?: unknown } | null | undefined,
  session?: ClientSession,
): Promise<boolean> {
  if (asMoney(user?.hourlyRate) !== null || asMoney(user?.weeklyBudget) !== null) {
    return true;
  }
  const query = PurchaseRecord.countDocuments({ userId, source: "survey" });
  if (session) {
    query.session(session);
  }
  return (await query) > 0;
}

async function rememberSurvey(
  userId: string,
  parsed: { hourlyRate: number | null; weeklyBudget: number | null; recentPurchases: SurveyPurchaseInput[] },
  saved: PurchaseView[],
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<void> {
  if (parsed.hourlyRate !== null) {
    await rememberLine(userId, budgetMemoryLine("hourly rate", parsed.hourlyRate), "goal", deps, { field: "hourlyRate" });
  }
  if (parsed.weeklyBudget !== null) {
    await rememberLine(userId, budgetMemoryLine("weekly budget", parsed.weeklyBudget), "goal", deps, { field: "weeklyBudget" });
  }
  for (let index = 0; index < parsed.recentPurchases.length; index += 1) {
    const purchase = parsed.recentPurchases[index];
    if (!purchase?.regretted) {
      continue;
    }
    const category = categoryForItem(purchase.item);
    const purchaseId = saved[index]?._id;
    await rememberLine(userId, purchaseVoteLine("regretted", purchase.item, category, purchase.price), "regret", deps, {
      category,
      feedback: "regretted",
      ...(purchaseId ? { purchaseId } : {}),
    });
  }
}

async function rememberLine(
  userId: string,
  line: string,
  kind: "goal" | "regret",
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    await writeUserMemoryLine(userId, line, kind, deps, meta);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Survey memory was not saved.");
  }
}

function parseSurvey(body: unknown): { hourlyRate: number | null; weeklyBudget: number | null; recentPurchases: SurveyPurchaseInput[] } {
  if (!isRecord(body)) {
    throw new SurveyError(400, "hourlyRate and weeklyBudget must be numbers or null.");
  }
  const hourlyRate = readMoneyField(body.hourlyRate, "hourlyRate");
  const weeklyBudget = readMoneyField(body.weeklyBudget, "weeklyBudget");
  const recentPurchases = readPurchases(body.recentPurchases);
  return { hourlyRate, weeklyBudget, recentPurchases };
}

function readMoneyField(value: unknown, name: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MONEY_CAP) {
    return value;
  }
  throw new SurveyError(400, `${name} must be a number or null.`);
}

function readPurchases(value: unknown): SurveyPurchaseInput[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 5) {
    throw new SurveyError(400, "recentPurchases can list at most 5 purchases.");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new SurveyError(400, "Each purchase needs an item, a price, and regretted true or false.");
    }
    const item = typeof entry.item === "string" ? entry.item.trim() : "";
    if (!item || item.length > 200 || !isPrice(entry.price) || typeof entry.regretted !== "boolean") {
      throw new SurveyError(400, "Each purchase needs an item, a price, and regretted true or false.");
    }
    return { item, price: entry.price, regretted: entry.regretted };
  });
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MONEY_CAP;
}

function asMoney(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function readSettings(userId: string): Promise<BudgetProfile> {
  return getBudgetProfile(userId);
}

export async function updateSettings(
  userId: string,
  body: unknown,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<BudgetProfile> {
  const parsed = parseSettingsPatch(body);
  const before = await getBudgetProfile(userId);
  const updated = await User.updateOne({ _id: userId }, { $set: parsed });
  if (updated.matchedCount !== 1) {
    throw new SurveyError(404, "User not found.");
  }
  if (parsed.hourlyRate !== undefined && parsed.hourlyRate !== before.hourlyRate) {
    await rememberSettingsLine(userId, budgetMemoryLine("hourly rate", parsed.hourlyRate), "goal", deps, { field: "hourlyRate" });
  }
  if (parsed.weeklyBudget !== undefined && parsed.weeklyBudget !== before.weeklyBudget) {
    await rememberSettingsLine(userId, budgetMemoryLine("weekly budget", parsed.weeklyBudget), "goal", deps, { field: "weeklyBudget" });
  }
  return getBudgetProfile(userId);
}

async function rememberSettingsLine(
  userId: string,
  line: string,
  kind: "goal" | "regret",
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    await writeUserMemoryLine(userId, line, kind, deps, meta);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Settings memory was not saved.");
  }
}

function parseSettingsPatch(body: unknown): { hourlyRate?: number; weeklyBudget?: number } {
  if (!isRecord(body)) {
    throw new SurveyError(400, "Enter hourly income or a weekly budget.");
  }
  const patch: { hourlyRate?: number; weeklyBudget?: number } = {};
  if ("hourlyRate" in body) {
    patch.hourlyRate = readPositiveMoney(body.hourlyRate, "Hourly income");
  }
  if ("weeklyBudget" in body) {
    patch.weeklyBudget = readPositiveMoney(body.weeklyBudget, "Weekly budget");
  }
  if (patch.hourlyRate === undefined && patch.weeklyBudget === undefined) {
    throw new SurveyError(400, "Enter hourly income or a weekly budget.");
  }
  return patch;
}

/** Positive finite money up to the survey cap. NaN and Infinity are rejected here. */
export function positiveSettingsAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MONEY_CAP) {
    return null;
  }
  return value;
}

function readPositiveMoney(value: unknown, label: string): number {
  const amount = positiveSettingsAmount(value);
  if (amount === null) {
    throw new SurveyError(400, `${label} must be a positive number.`);
  }
  return amount;
}
