import type { OutboundMessage } from "../channel.js";
import type { AccountDirectory } from "../auth/accounts.js";
import type { BackboardClient } from "../memory/backboard.js";
import { PurchaseRecord } from "../purchases/model.js";
import { setPurchaseFeedback } from "../purchases/service.js";
import { CHECK_IN_DELAY_MS, CheckIn } from "./model.js";
import { checkInText, parseWorthReply } from "./reply.js";

export type CheckInLink = {
  conversationId: string;
  agentSenderId?: string;
};

export type CheckInSender = {
  now: Date;
  linkFor: (userId: string) => CheckInLink | null;
  send: (message: OutboundMessage) => Promise<void>;
};

const BATCH = 20;

/** One row per purchase. A second call leaves the original due time in place. */
export async function ensureCheckIn(userId: string, purchaseId: string, now = new Date()): Promise<void> {
  const dueAt = new Date(now.getTime() + CHECK_IN_DELAY_MS);
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
}

/**
 * The check-in row already exists. Stamp sentAt, then send.
 * A send failure clears sentAt so the next pass can retry.
 * No linked thread means we do not stamp, and the row stays due.
 */
export async function sendDueCheckIns(deps: CheckInSender): Promise<number> {
  const due = await CheckIn.find({
    dueAt: { $lte: deps.now },
    sentAt: null,
    answeredAt: null,
  })
    .sort({ dueAt: 1 })
    .limit(BATCH);
  let sent = 0;
  for (const row of due) {
    const userId = row.userId.toString();
    const link = deps.linkFor(userId);
    if (!link) {
      continue;
    }
    const claimed = await CheckIn.findOneAndUpdate(
      { _id: row._id, sentAt: null, answeredAt: null },
      { $set: { sentAt: deps.now } },
      { returnDocument: "after" },
    );
    if (!claimed) {
      continue;
    }
    const purchase = await PurchaseRecord.findById(claimed.purchaseId).select("item");
    const text = checkInText(typeof purchase?.item === "string" ? purchase.item : "");
    try {
      await deps.send({
        conversationId: link.conversationId,
        text,
        ...(link.agentSenderId ? { agentSenderId: link.agentSenderId } : {}),
        idempotencyKey: `simmer:checkin:${claimed.purchaseId.toString()}`,
      });
      sent += 1;
    } catch (error: unknown) {
      await CheckIn.updateOne({ _id: claimed._id, answeredAt: null }, { $set: { sentAt: null } });
      console.error(error instanceof Error ? error.message : "Check-in send failed.");
    }
  }
  return sent;
}

export async function hasOpenCheckIn(userId: string): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/i.test(userId)) {
    return false;
  }
  const found = await CheckIn.exists({
    userId,
    sentAt: { $ne: null },
    answeredAt: null,
    answer: null,
  });
  return found != null;
}

/**
 * Claims the sender's newest sent, unanswered check-in and writes kept/regretted
 * on that purchase. A purchase owned by someone else is not updated.
 */
export async function answerCheckIn(
  userId: string,
  answer: "yes" | "no",
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
  now = new Date(),
): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/i.test(userId)) {
    return false;
  }
  const claimed = await CheckIn.findOneAndUpdate(
    { userId, sentAt: { $ne: null }, answeredAt: null, answer: null },
    { $set: { answeredAt: now, answer } },
    { sort: { sentAt: -1 }, returnDocument: "before" },
  );
  if (!claimed) {
    return false;
  }
  try {
    await setPurchaseFeedback(userId, claimed.purchaseId.toString(), answer === "yes" ? "kept" : "regretted", deps);
  } catch (error: unknown) {
    await CheckIn.updateOne({ _id: claimed._id }, { $set: { answeredAt: null, answer: null } });
    throw error;
  }
  return true;
}

/** True only when this linked user has an open sent check-in and the text is yes or no. */
export async function takeCheckInReply(
  userId: string | null,
  text: string,
  deps: { directory: AccountDirectory; client: BackboardClient; remote: boolean },
  now = new Date(),
): Promise<boolean> {
  const answer = parseWorthReply(text);
  if (!userId || !answer) {
    return false;
  }
  if (!(await hasOpenCheckIn(userId))) {
    return false;
  }
  return answerCheckIn(userId, answer, deps, now);
}

export async function fireCheckInNow(
  purchaseId: string,
  deps: CheckInSender,
): Promise<{ status: number; body: { ok: true; sent: number } | { error: string } }> {
  if (!/^[a-f0-9]{24}$/i.test(purchaseId)) {
    return { status: 404, body: { error: "Check-in not found." } };
  }
  const updated = await CheckIn.findOneAndUpdate(
    { purchaseId, answeredAt: null },
    { $set: { dueAt: deps.now, sentAt: null } },
    { returnDocument: "after" },
  );
  if (!updated) {
    return { status: 404, body: { error: "Check-in not found." } };
  }
  const sent = await sendDueCheckIns(deps);
  return { status: 200, body: { ok: true, sent } };
}
