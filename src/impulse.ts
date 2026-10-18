import { liftCart, sleepCart, VAULT_MS } from "./carts.js";
import type { ExtractOptions } from "./extract-signals.js";
import { unwrapJsonFence } from "./extract-signals.js";
import { formatUsd } from "./format.js";
import { grokChat, DEFAULT_XAI_MODEL, DEFAULT_XAI_TIMEOUT_MS } from "./grok.js";
import { formatImpulseScore } from "./scoring/lockBand.js";
import { assertNever, type Cart, type Decision, type ScoreBucket, type SignalSource } from "./types.js";

export type { ScoreBucket };

export type NecessityRead = {
  necessary: boolean;
  source: SignalSource;
  reason: string;
};

export type GradeRead = {
  grade: number;
  source: SignalSource;
  reason: string;
};

const PHONE_UPGRADE =
  /\b(iphones?|phones?|macbooks?|ipads?|airpods|watches?|upgrade|example phone)\b/i;
const REPLACEMENT = /\b(chargers?|charge cable|charging cable|cables?|adapters?|replacements?|repairs?)\b/i;

export function clampGrade(value: number): number {
  return clampInteger(value, -3, 3);
}

export function clampImpulse(value: number): number {
  return clampInteger(value, 1, 5);
}

/** Impulse history plus the justification grade, clamped to 1–5. */
export function purchaseScore(userImpulseScore: number, justificationGrade: number): number {
  return clampImpulse(clampImpulse(userImpulseScore) + clampGrade(justificationGrade));
}

/** 1 is strict, 2–3 is soft, 4 and above unlocks. */
export function scoreBucket(score: number): ScoreBucket {
  const clamped = clampImpulse(score);
  if (clamped >= 4) {
    return "free";
  }
  if (clamped >= 2) {
    return "soft";
  }
  return "strict";
}

/** Necessary bags are not locked. */
export function locksCheckout(read: Pick<NecessityRead, "necessary">): boolean {
  return !read.necessary;
}

export function keywordNecessity(bagText: string): Pick<NecessityRead, "necessary" | "reason"> {
  const text = bagText.trim();
  if (REPLACEMENT.test(text)) {
    return { necessary: true, reason: "A cable, charger, adapter, or repair keeps a device working." };
  }
  if (PHONE_UPGRADE.test(text)) {
    return { necessary: false, reason: "A new phone or upgrade is not a necessary buy." };
  }
  return { necessary: false, reason: "Nothing in the bag reads as a necessary replacement." };
}

export async function classifyNecessity(bagText: string, options: ExtractOptions = {}): Promise<NecessityRead> {
  const keyword = keywordNecessity(bagText);
  const grok = await grokNecessity(bagText, options);
  if (!grok) {
    return { necessary: keyword.necessary, source: "keywords", reason: keyword.reason };
  }
  return { necessary: grok.necessary, source: "grok", reason: grok.reason };
}

/** Keyword grade from -3 (pure impulse) to +3 (clearly necessary). */
export function keywordGrade(text: string): { grade: number; reason: string } {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return { grade: 0, reason: "No reason yet." };
  }
  const need = /\b(need|needed|for work|work tomorrow|deadline)\b/.test(normalized);
  const broken =
    /\b(cracked|cracks|crack|shattered|shatter|smashed|broken|battery|dies|dying|unusable)\b/.test(normalized) ||
    /won'?t turn on|will not turn on/.test(normalized);
  const high = /\b(tomorrow|today|asap|right now|urgent|dies by|can't use|cannot use|work tomorrow)\b/.test(normalized);
  if (need && broken && high) {
    return { grade: 3, reason: "A broken phone is needed right away." };
  }
  if ((need && broken) || (need && high) || (broken && high)) {
    return { grade: 2, reason: "The reason names a real problem." };
  }
  if (need) {
    return { grade: 1, reason: "A need, without a broken phone." };
  }
  if (/\b(bored|impulse|treat myself|just because|don'?t need|do not need)\b/.test(normalized)) {
    return { grade: -3, reason: "Pure impulse." };
  }
  if (/\b(looks nice|new color|the color|for fun|pretty)\b/.test(normalized)) {
    return { grade: -2, reason: "The new look is the reason." };
  }
  if (/\bwant\b/.test(normalized)) {
    return { grade: -1, reason: "A want, not a need." };
  }
  return { grade: 0, reason: "No clear reason." };
}

export function parseNecessityJson(raw: string): { necessary: boolean; reason: string } | null {
  const parsed = parseJson(raw);
  if (!isRecord(parsed) || typeof parsed.necessary !== "boolean") {
    return null;
  }
  return {
    necessary: parsed.necessary,
    reason: shortReason(parsed.reason, parsed.necessary ? "Necessary buy." : "Unnecessary buy."),
  };
}

/** Pulls an integer grade out of a Grok body and clamps it to -3..3. */
export function parseGradeJson(raw: string): { grade: number; reason: string } | null {
  const parsed = parseJson(raw);
  const record = isRecord(parsed) ? parsed : null;
  const candidate = record ? record.grade : parsed;
  const numeric =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && /^-?\d+$/.test(candidate.trim())
        ? Number(candidate.trim())
        : null;
  if (numeric === null || !Number.isFinite(numeric)) {
    return null;
  }
  return { grade: clampGrade(numeric), reason: shortReason(record?.reason, "Graded from the reply.") };
}

export async function gradeJustification(text: string, options: ExtractOptions = {}): Promise<GradeRead> {
  const keyword = keywordGrade(text);
  const grok = await grokGrade(text, options);
  if (!grok) {
    return { grade: keyword.grade, source: "keywords", reason: keyword.reason };
  }
  return { grade: grok.grade, source: "grok", reason: grok.reason };
}

export function alternativeLine(decision: Decision): string {
  if (decision.offerName && decision.mathSavingsCents > 0) {
    return `Alternative: wait ${decision.mathWaitMonths} months for the ${decision.offerName} and save ${formatUsd(decision.mathSavingsCents)}. Example data, not a current carrier deal.`;
  }
  if (decision.mathAction === "sleep" && decision.mathSavingsCents > 0) {
    return `Alternative: wait ${decision.mathWaitMonths} months and save ${formatUsd(decision.mathSavingsCents)}.`;
  }
  return "Alternative: waiting does not cost less than buying now.";
}

export function scoreReply(input: {
  impulse: number;
  grade: number;
  score: number;
  bucket: ScoreBucket;
  gradeSource: SignalSource;
  alternative: string;
  /** 1–8 impulsiveness, when the cart has a backboard reading. */
  impulseScore1to8?: number | null;
  impulseWhy?: string | null;
}): string {
  const signed = input.grade > 0 ? `+${input.grade}` : String(input.grade);
  const math =
    input.impulseScore1to8 != null
      ? `Purchase score ${input.score} (${input.gradeSource} grade ${signed}). Impulsiveness ${formatImpulseScore(input.impulseScore1to8)} of 8.${input.impulseWhy ? ` ${input.impulseWhy}` : ""}`
      : `Purchase score ${input.score} = impulse ${input.impulse} + grade ${signed} (${input.gradeSource}).`;
  switch (input.bucket) {
    case "free":
      return `${math} Score ${input.score} unlocks the bag. Apple's button works again. Simmer will not click it.`;
    case "soft":
      return `${math} Score ${input.score} is soft. ${input.alternative} Sleep on it if you want. That pause is optional.`;
    case "strict":
      return `${math} Score 1 holds this bag for 24 hours. ${input.alternative} Demo: skip 24 hours is the only early way out.`;
    default:
      return assertNever(input.bucket);
  }
}

/**
 * Writes the score onto the cart and moves the lock.
 * Score 1 vaults for 24 hours. Score 2–3 stays locked until the shopper chooses sleep.
 * Score 4+ lifts the lock and any vault.
 */
export function applyPurchaseScore(
  cart: Cart,
  grade: GradeRead,
  userImpulseScore: number,
  now: Date,
  demoReminderMs: number,
): { bucket: ScoreBucket; reply: string } {
  const impulse = clampImpulse(userImpulseScore);
  const score = purchaseScore(impulse, grade.grade);
  const bucket = scoreBucket(score);
  cart.userImpulseScore = impulse;
  cart.justificationGrade = grade.grade;
  cart.gradeSource = grade.source;
  cart.gradeReason = grade.reason;
  cart.purchaseScore = score;
  cart.scoreBucket = bucket;
  const decision = cart.decision;
  const reply = scoreReply({
    impulse,
    grade: grade.grade,
    score,
    bucket,
    gradeSource: grade.source,
    alternative: decision ? alternativeLine(decision) : "Alternative: not ready yet.",
    impulseScore1to8: cart.impulse?.score1to8 ?? null,
    impulseWhy: cart.impulse?.why ?? null,
  });
  cart.scoreReason = grade.reason;
  const phrase = withoutScorePreface(cart.explanation);
  cart.explanation = phrase ? `${reply}\n\n${phrase}` : reply;
  switch (bucket) {
    case "free":
      liftCart(cart);
      return { bucket, reply };
    case "soft":
      if (cart.status === "vault" && cart.vaultMode !== "soft") {
        cart.vaultUntil = null;
        cart.vaultMode = null;
        cart.status = "locked";
        cart.isUnlocked = false;
      }
      return { bucket, reply };
    case "strict":
      sleepCart(cart, now, VAULT_MS, demoReminderMs, "enforced");
      return { bucket, reply };
    default:
      return assertNever(bucket);
  }
}

function withoutScorePreface(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const parts = text.split("\n\n");
  if (parts[0]?.startsWith("Purchase score ")) {
    const rest = parts.slice(1).join("\n\n").trim();
    return rest.length > 0 ? rest : null;
  }
  return text;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function shortReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 160) : fallback;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(unwrapJsonFence(raw)) as unknown;
  } catch {
    return null;
  }
}

async function grokNecessity(
  bagText: string,
  options: ExtractOptions,
): Promise<{ necessary: boolean; reason: string } | null> {
  if (!options.apiKey) {
    return null;
  }
  const prompt = [
    "Classify whether this Apple bag purchase is necessary or unnecessary.",
    "Reply with JSON only, no markdown.",
    '{"necessary": true or false, "reason": "short"}',
    "necessary is true only for a replacement part, cable, charger, adapter, or repair that keeps a device the shopper already owns working.",
    "necessary is false for a new phone, an upgrade, headphones, a watch, or anything that reads as a want.",
    "",
    bagText,
  ].join("\n");
  const raw = await grokChat({
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_XAI_MODEL,
    timeoutMs: options.timeoutMs ?? DEFAULT_XAI_TIMEOUT_MS,
    prompt,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (!raw) {
    return null;
  }
  return parseNecessityJson(raw);
}

async function grokGrade(text: string, options: ExtractOptions): Promise<{ grade: number; reason: string } | null> {
  if (!options.apiKey) {
    return null;
  }
  const prompt = [
    "Grade how genuine and necessary this checkout justification is.",
    "Reply with JSON only, no markdown.",
    '{"grade": an integer from -3 to 3, "reason": "short"}',
    "-3 is pure impulse, such as a new color, boredom, or buying for no reason.",
    "0 is unclear.",
    "+3 is clearly necessary, such as a broken phone needed for work right now.",
    "",
    text,
  ].join("\n");
  const raw = await grokChat({
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_XAI_MODEL,
    timeoutMs: options.timeoutMs ?? DEFAULT_XAI_TIMEOUT_MS,
    prompt,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (!raw) {
    return null;
  }
  return parseGradeJson(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
