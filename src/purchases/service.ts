import type { Cart } from "../types.js";
import type { AccountDirectory, AccountUser } from "../auth/accounts.js";
import { MemoryNote } from "../auth/user.js";
import { assistantForUser } from "../memory/service.js";
import { waitForMemoryWrite, type BackboardClient, type MemoryKind } from "../memory/backboard.js";
import { PurchaseRecord } from "./model.js";

export type PurchaseFeedback = "regretted" | "kept";

export type PurchaseView = {
  _id: string;
  userId: string;
  item: string;
  category: string;
  price: number;
  verdict: string;
  feedback: PurchaseFeedback | null;
  isExample: boolean;
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

const EXAMPLES: { item: string; category: string; price: number; verdict: string }[] = [
  { item: "iPhone 16", category: "phone", price: 799, verdict: "unlock" },
  { item: "USB-C Charge Cable", category: "cable", price: 19, verdict: "unlock" },
  { item: "AirPods", category: "audio", price: 179, verdict: "sleep" },
  { item: "MagSafe Case", category: "case", price: 49, verdict: "sleep" },
  { item: "Apple Watch", category: "watch", price: 399, verdict: "unlock" },
];

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

export async function hasRegrettedPurchase(userId: string, category: string): Promise<boolean> {
  const found = await PurchaseRecord.exists({
    userId,
    category: category.trim().toLowerCase(),
    feedback: "regretted",
  });
  return found != null;
}

export async function listPurchases(userId: string, limit: number): Promise<PurchaseView[]> {
  const real = await PurchaseRecord.countDocuments({ userId, isExample: false });
  if (real === 0) {
    const examples = await PurchaseRecord.countDocuments({ userId, isExample: true });
    if (examples === 0) {
      const now = Date.now();
      await PurchaseRecord.insertMany(
        EXAMPLES.map((row, index) => ({
          userId,
          item: row.item,
          category: row.category,
          price: row.price,
          verdict: row.verdict,
          feedback: null,
          isExample: true,
          ratedAt: null,
          createdAt: new Date(now - (EXAMPLES.length - index) * 60_000),
        })),
      );
    }
  }
  const docs = await PurchaseRecord.find(real === 0 ? { userId, isExample: true } : { userId, isExample: false })
    .sort({ createdAt: -1 })
    .limit(limit);
  return docs.map(toView);
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
  if (doc.userId.toString() !== userId) {
    throw new PurchaseError(403, "That purchase belongs to someone else.");
  }
  if (doc.feedback === feedback) {
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

export async function recordUnlockedPurchase(userId: string, cart: Cart): Promise<void> {
  const existing = await PurchaseRecord.findOne({ userId, cartCode: cart.code });
  if (existing) {
    return;
  }
  const item = cart.items[0]?.name ?? "Apple bag";
  await PurchaseRecord.create({
    userId,
    item,
    category: categoryForItem(item),
    price: cart.totalCents / 100,
    verdict: cart.decision?.action ?? "unlock",
    feedback: null,
    isExample: false,
    ratedAt: null,
    cartCode: cart.code,
  });
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
  const assistantId = await assistantIdForVote(user, deps);
  const write = await deps.client.addMemory(assistantId, { content: line, metadata: { type: kind, category } });
  const settled = await waitForMemoryWrite(deps.client, write);
  if (settled.status === "ERROR") {
    throw new Error("Backboard memory write failed.");
  }
  await MemoryNote.create({
    userId,
    type: kind,
    text: line,
    meta: { category, feedback },
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

function toView(doc: {
  _id: { toString(): string };
  userId: { toString(): string };
  item: string;
  category: string;
  price: number;
  verdict: string;
  feedback?: string | null;
  isExample: boolean;
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
    verdict: doc.verdict,
    feedback,
    isExample: doc.isExample,
    createdAt: doc.createdAt?.toISOString() ?? new Date(0).toISOString(),
    ratedAt: doc.ratedAt ? doc.ratedAt.toISOString() : null,
  };
}
