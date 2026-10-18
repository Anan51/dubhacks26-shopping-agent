import type { ClientSession } from "mongoose";

import type { Cart } from "../types.js";
import type { AccountDirectory, AccountUser } from "../auth/accounts.js";
import { MemoryNote, User } from "../auth/user.js";
import { assistantForUser } from "../memory/service.js";
import { isRecord } from "../record.js";
import { waitForMemoryWrite, type BackboardClient, type MemoryKind } from "../memory/backboard.js";
import { rememberCheckIn } from "../checkins/ensure.js";
import { PurchaseRecord } from "./model.js";

export type PurchaseFeedback = "regretted" | "kept";

export type PurchaseView = {
  _id: string;
  userId: string;
  item: string;
  category: string;
  price: number;
  verdict: string | null;
  feedback: PurchaseFeedback | null;
  isExample: boolean;
  source: "survey" | "checkout";
  createdAt: string;
  ratedAt: string | null;
};

export class PurchaseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PurchaseError";
    this.status = status;
  }
}

export function historyLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : 15;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 15;
  }
  return Math.min(parsed, 15);
}

export function categoryForItem(name: string): string {
  const text = name.toLowerCase();
  if (/\b(cable|charger|adapter)\b/.test(text)) {
    return "cable";
  }
  if (/\b(case|cover)\b/.test(text)) {
    return "case";
  }
  if (/\b(airpods|headphones|earbuds)\b/.test(text)) {
    return "audio";
  }
  if (/\bwatch\b/.test(text)) {
    return "watch";
  }
  if (/\b(ipad|tablet)\b/.test(text)) {
    return "tablet";
  }
  if (/\b(mac|laptop)\b/.test(text)) {
    return "computer";
  }
  if (/\b(phone|iphone)\b/.test(text)) {
    return "phone";
  }
  return "other";
}

export function formatPurchasePrice(price: number): string {
  const cents = Math.round(price * 100) % 100;
  return price.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function purchaseVoteLine(feedback: PurchaseFeedback, item: string, category: string, price: number): string {
  return `${feedback} purchase: ${item} (${category}, ${formatPurchasePrice(price)})`;
}

export function budgetMemoryLine(field: "hourly rate" | "weekly budget", amount: number): string {
  return `${field}: ${formatPurchasePrice(amount)}`;
}

export type BudgetProfile = {
  hourlyRate: number | null;
  weeklyBudget: number | null;
};

export async function getBudgetProfile(userId: string): Promise<BudgetProfile> {
  const user = await findUser(userId);
  return {
    hourlyRate: numberOrNull(user?.hourlyRate),
    weeklyBudget: numberOrNull(user?.weeklyBudget),
  };
}

export async function getHourlyRate(userId: string): Promise<number | null> {
  return (await getBudgetProfile(userId)).hourlyRate;
}

export async function getWeeklyBudget(userId: string): Promise<number | null> {
  return (await getBudgetProfile(userId)).weeklyBudget;
}

export async function weeklySpend(userId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await PurchaseRecord.find({
    userId,
    isExample: false,
    createdAt: { $gte: since },
  }).select("price");
  return rows.reduce((sum, row) => sum + (typeof row.price === "number" ? row.price : 0), 0);
}

export async function surveyWasCompleted(userId: string): Promise<boolean> {
  const user = await findUser(userId);
  return user?.surveyCompleted === true;
}

export async function countRegrets(userId: string, category?: string): Promise<number> {
  const filter: { userId: string; feedback: "regretted"; isExample: false; category?: string } = {
    userId,
    feedback: "regretted",
    isExample: false,
  };
  const narrowed = category?.trim().toLowerCase() ?? "";
  if (narrowed.length > 0) {
    filter.category = narrowed;
  }
  return PurchaseRecord.countDocuments(filter);
}

export type SavedGoal = {
  text: string;
  targetAmount: number | null;
  createdAt: string;
};

export async function getSavedGoals(userId: string): Promise<SavedGoal[]> {
  const user = await findUser(userId);
  if (!user || !Array.isArray(user.goals)) {
    return [];
  }
  return user.goals.flatMap((goal) => {
    if (!isGoal(goal)) {
      return [];
    }
    const createdAt = goal.createdAt instanceof Date ? goal.createdAt.toISOString() : "";
    const targetAmount = typeof goal.targetAmount === "number" && Number.isFinite(goal.targetAmount) ? goal.targetAmount : null;
    return [{ text: goal.text, targetAmount, createdAt }];
  });
}

export async function hasRegrettedPurchase(userId: string, category: string): Promise<boolean> {
  const found = await PurchaseRecord.exists({
    userId,
    category: category.trim().toLowerCase(),
    feedback: "regretted",
    isExample: false,
  });
  return found != null;
}

/**
 * Recent real purchases for the impulsiveness score.
 * Uses the same isExample:false filter as popup history, so survey rows count and seeded examples do not.
 */
export async function getPurchaseHistory(userId: string, limit: number): Promise<PurchaseView[]> {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 50;
  return listPurchases(userId, capped);
}

/** Real purchases only. Survey rows the shopper entered are already isExample false. Example rows stay hidden. */
export async function listPurchases(userId: string, limit: number): Promise<PurchaseView[]> {
  const docs = await PurchaseRecord.find({ userId, isExample: false }).sort({ createdAt: -1 }).limit(limit);
  return docs.map(toView);
}

export async function insertRealPurchase(
  input: {
    userId: string;
    item: string;
    category: string;
    price: number;
    verdict: string | null;
    feedback: PurchaseFeedback | null;
    source?: "survey" | "checkout";
  },
  options?: { session?: ClientSession },
): Promise<PurchaseView> {
  const payload = {
    userId: input.userId,
    item: input.item,
    category: input.category.trim().toLowerCase(),
    price: input.price,
    verdict: input.verdict,
    feedback: input.feedback,
    isExample: false,
    source: input.source ?? "checkout",
    ratedAt: input.feedback ? new Date() : null,
    cartCode: null,
  };
  if (options?.session) {
    const created = await PurchaseRecord.create([payload], { session: options.session });
    const doc = created[0];
    if (!doc) {
      throw new PurchaseError(500, "Purchase was not recorded.");
    }
    return toView(doc);
  }
  const doc = await PurchaseRecord.create(payload);
  return toView(doc);
}

export async function setPurchaseFeedback(
  userId: string,
  purchaseId: string,
  feedback: PurchaseFeedback | null,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<PurchaseView> {
  if (!/^[a-f0-9]{24}$/i.test(purchaseId)) {
    throw new PurchaseError(404, "Purchase not found.");
  }
  const doc = await PurchaseRecord.findById(purchaseId);
  if (!doc) {
    throw new PurchaseError(404, "Purchase not found.");
  }
  if (doc.userId.toString() !== userId || doc.isExample === true) {
    throw new PurchaseError(404, "Purchase not found.");
  }
  if (doc.feedback === feedback) {
    if (feedback) {
      await rememberVoteIfMissing(userId, doc.item, doc.category, doc.price, feedback, deps);
    }
    return toView(doc);
  }
  doc.feedback = feedback;
  doc.ratedAt = feedback ? new Date() : null;
  await doc.save();
  if (feedback) {
    await writeVoteMemory(userId, doc.item, doc.category, doc.price, feedback, deps);
  }
  return toView(doc);
}

/** Owner-scoped hard delete. Unknown ids answer 404. Example rows are included. */
export async function deletePurchase(userId: string, purchaseId: string): Promise<void> {
  if (!/^[a-f0-9]{24}$/i.test(purchaseId) || !/^[a-f0-9]{24}$/i.test(userId)) {
    throw new PurchaseError(404, "Purchase not found.");
  }
  const doc = await PurchaseRecord.findOneAndDelete({ _id: purchaseId, userId });
  if (!doc) {
    throw new PurchaseError(404, "Purchase not found.");
  }
  await forgetPurchaseVoteNotes(userId, doc.item, doc.category, doc.price);
}

async function forgetPurchaseVoteNotes(userId: string, item: string, category: string, price: number): Promise<void> {
  const lines = [purchaseVoteLine("regretted", item, category, price), purchaseVoteLine("kept", item, category, price)];
  await MemoryNote.deleteMany({ userId, text: { $in: lines } });
  // TODO: BackboardClient has no per-memory delete. resetMemories wipes the assistant,
  // and deleteAssistant removes the assistant. The vote line written with addMemory stays on Backboard.
}

export async function recordCheckedOutBag(userId: string, cart: Cart): Promise<{ purchase: PurchaseView; created: boolean }> {
  if (cart.isUnlocked !== true || cart.status !== "unlocked") {
    throw new PurchaseError(409, "This bag is still locked.");
  }
  const existing = await PurchaseRecord.findOne({ userId, cartCode: cart.code });
  if (existing) {
    await rememberCheckIn(userId, existing._id.toString());
    return { purchase: toView(existing), created: false };
  }
  const item = cart.items[0]?.name?.trim() || "Apple bag";
  const payload = {
    userId,
    item,
    category: categoryForItem(item),
    price: cart.totalCents / 100,
    verdict: cart.decision?.action ?? "unlock",
    feedback: null,
    isExample: false as const,
    ratedAt: null,
    cartCode: cart.code,
    source: "checkout" as const,
  };
  try {
    const doc = await PurchaseRecord.create(payload);
    await rememberCheckIn(userId, doc._id.toString());
    return { purchase: toView(doc), created: true };
  } catch (error: unknown) {
    if (!isDuplicateKey(error)) {
      throw error;
    }
    const again = await PurchaseRecord.findOne({ userId, cartCode: cart.code });
    if (!again) {
      throw new PurchaseError(500, "Purchase was not recorded.");
    }
    await rememberCheckIn(userId, again._id.toString());
    return { purchase: toView(again), created: false };
  }
}

async function rememberVoteIfMissing(
  userId: string,
  item: string,
  category: string,
  price: number,
  feedback: PurchaseFeedback,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<void> {
  const line = purchaseVoteLine(feedback, item, category, price);
  const saved = await MemoryNote.exists({ userId, text: line });
  if (saved) {
    return;
  }
  await writeVoteMemory(userId, item, category, price, feedback, deps);
}

async function writeVoteMemory(
  userId: string,
  item: string,
  category: string,
  price: number,
  feedback: PurchaseFeedback,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<void> {
  const user = await deps.directory.findById(userId);
  if (!user) {
    return;
  }
  const line = purchaseVoteLine(feedback, item, category, price);
  const kind: MemoryKind = feedback === "regretted" ? "regret" : "goal";
  await writeUserMemoryLine(userId, line, kind, deps, { category, feedback });
}

export async function writeUserMemoryLine(
  userId: string,
  line: string,
  kind: MemoryKind,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
  meta: Record<string, unknown> = {},
): Promise<void> {
  const user = await deps.directory.findById(userId);
  if (!user) {
    return;
  }
  const assistantId = await assistantIdForVote(user, deps);
  const write = await deps.client.addMemory(assistantId, { content: line, metadata: { type: kind, ...meta } });
  const settled = await waitForMemoryWrite(deps.client, write);
  if (settled.status !== "COMPLETED") {
    throw new Error("Backboard memory write failed.");
  }
  await MemoryNote.create({
    userId,
    type: kind,
    text: line,
    meta,
    backboardMemoryId: settled.memoryId,
  });
}

async function assistantIdForVote(
  user: AccountUser,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
): Promise<string> {
  if (deps.remote) {
    return assistantForUser(user, deps.directory, deps.client);
  }
  if (user.backboardAssistantId) {
    return user.backboardAssistantId;
  }
  const created = await deps.client.createAssistant({
    name: `Simmer ${user.id}`.slice(0, 255),
    systemPrompt: "You remember one shopper's regrets, goals, and items they returned. Do not invent purchases.",
  });
  return created.assistantId;
}

async function findUser(userId: string): Promise<{
  hourlyRate?: unknown;
  weeklyBudget?: unknown;
  surveyCompleted?: unknown;
  goals?: unknown;
} | null> {
  if (!/^[a-f0-9]{24}$/i.test(userId)) {
    return null;
  }
  return User.findById(userId).select("hourlyRate weeklyBudget surveyCompleted goals");
}

function isDuplicateKey(error: unknown): boolean {
  return isRecord(error) && error.code === 11000;
}

function isGoal(value: unknown): value is { text: string; targetAmount?: unknown; createdAt?: unknown } {
  return isRecord(value) && typeof value.text === "string" && value.text.length > 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toView(doc: {
  _id: { toString(): string };
  userId: { toString(): string };
  item: string;
  category: string;
  price: number;
  verdict?: string | null;
  feedback?: string | null;
  isExample: boolean;
  source?: string | null;
  createdAt?: Date;
  ratedAt?: Date | null;
}): PurchaseView {
  const feedback = doc.feedback === "regretted" || doc.feedback === "kept" ? doc.feedback : null;
  return {
    _id: doc._id.toString(),
    userId: doc.userId.toString(),
    item: doc.item,
    category: doc.category,
    price: doc.price,
    verdict: typeof doc.verdict === "string" && doc.verdict.length > 0 ? doc.verdict : null,
    feedback,
    isExample: doc.isExample,
    source: doc.source === "survey" ? "survey" : "checkout",
    createdAt: doc.createdAt?.toISOString() ?? new Date(0).toISOString(),
    ratedAt: doc.ratedAt ? doc.ratedAt.toISOString() : null,
  };
}
