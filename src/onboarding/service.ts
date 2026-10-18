import mongoose from "mongoose";

import type { AccountDirectory } from "../auth/accounts.js";
import { User } from "../auth/user.js";
import type { BackboardClient } from "../memory/backboard.js";
import { isRecord } from "../record.js";
import {
  budgetMemoryLine,
  categoryForItem,
  getBudgetProfile,
  insertRealPurchase,
  purchaseVoteLine,
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

export async function readSurvey(userId: string): Promise<SurveyView> {
  const user = await User.findById(userId).select("hourlyRate weeklyBudget surveyCompleted");
  return {
    completed: user?.surveyCompleted === true,
    hourlyRate: asMoney(user?.hourlyRate),
    weeklyBudget: asMoney(user?.weeklyBudget),
  };
}

export async function submitSurvey(
  userId: string,
  body: unknown,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<SurveyView & { purchases: PurchaseView[] }> {
  const parsed = parseSurvey(body);
  const session = await mongoose.startSession();
  let purchases: PurchaseView[] = [];
  try {
    await session.withTransaction(async () => {
      purchases = [];
      const existing = await User.findById(userId).session(session);
      if (!existing) {
        throw new SurveyError(404, "User not found.");
      }
      if (existing.surveyCompleted === true) {
        throw new SurveyError(409, "Survey already completed.");
      }
      const updated = await User.updateOne(
        { _id: userId, surveyCompleted: { $ne: true } },
        { $set: { hourlyRate: parsed.hourlyRate, weeklyBudget: parsed.weeklyBudget, surveyCompleted: true } },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new SurveyError(409, "Survey already completed.");
      }
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
  await rememberSurvey(userId, parsed, deps);
  return {
    completed: true,
    hourlyRate: parsed.hourlyRate,
    weeklyBudget: parsed.weeklyBudget,
    purchases,
  };
}

async function rememberSurvey(
  userId: string,
  parsed: { hourlyRate: number | null; weeklyBudget: number | null; recentPurchases: SurveyPurchaseInput[] },
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<void> {
  if (parsed.hourlyRate !== null) {
    await rememberLine(userId, budgetMemoryLine("hourly rate", parsed.hourlyRate), "goal", deps, { field: "hourlyRate" });
  }
  if (parsed.weeklyBudget !== null) {
    await rememberLine(userId, budgetMemoryLine("weekly budget", parsed.weeklyBudget), "goal", deps, { field: "weeklyBudget" });
  }
  for (const purchase of parsed.recentPurchases) {
    if (!purchase.regretted) {
      continue;
    }
    const category = categoryForItem(purchase.item);
    await rememberLine(userId, purchaseVoteLine("regretted", purchase.item, category, purchase.price), "regret", deps, {
      category,
      feedback: "regretted",
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
  if (parsed.hourlyRate !== undefined) {
    await writeUserMemoryLine(userId, budgetMemoryLine("hourly rate", parsed.hourlyRate), "goal", deps, { field: "hourlyRate" });
  }
  if (parsed.weeklyBudget !== undefined) {
    await writeUserMemoryLine(userId, budgetMemoryLine("weekly budget", parsed.weeklyBudget), "goal", deps, { field: "weeklyBudget" });
  }
  await User.updateOne({ _id: userId }, { $set: parsed });
  return getBudgetProfile(userId);
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

function readPositiveMoney(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MONEY_CAP) {
    return value;
  }
  throw new SurveyError(400, `${label} must be a positive number.`);
}
