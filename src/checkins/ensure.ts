import { PurchaseRecord } from "../purchases/model.js";
import { CHECK_IN_DELAY_MS, CheckIn } from "./model.js";

/** One row per purchase. A second call leaves the original due time in place. Rated purchases are skipped. */
export async function ensureCheckIn(userId: string, purchaseId: string, now = new Date()): Promise<void> {
  if (!/^[a-f0-9]{24}$/i.test(purchaseId)) {
    throw new Error("Check-in needs a purchase id.");
  }
  const purchase = await PurchaseRecord.findById(purchaseId).select("feedback");
  if (!purchase || purchase.feedback === "kept" || purchase.feedback === "regretted") {
    return;
  }
  const dueAt = new Date(now.getTime() + CHECK_IN_DELAY_MS);
  try {
    await CheckIn.updateOne(
      { purchaseId },
      {
        $setOnInsert: {
          userId,
          purchaseId,
          dueAt,
          sentAt: null,
          answeredAt: null,
          answer: null,
        },
      },
      { upsert: true },
    );
  } catch (error: unknown) {
    if (isDuplicate(error)) {
      return;
    }
    throw error;
  }
}

/** Saves a check-in when it can. A failure is logged so the purchase response can still succeed. */
export async function rememberCheckIn(userId: string, purchaseId: string, now = new Date()): Promise<void> {
  try {
    await ensureCheckIn(userId, purchaseId, now);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Check-in was not saved.");
  }
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === 11000;
}
