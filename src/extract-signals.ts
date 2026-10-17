import type { Condition, ConversationContext, Signals } from "./types.js";

/**
 * Turn one shopper message into partial heuristic inputs.
 * Keyword and regex only. `decide` never sees raw text, and phrasing never parses it.
 * A later model can replace this body; keep the signature stable.
 */
export function extractSignals(text: string, conversation: ConversationContext): Partial<Signals> {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  const patch: Partial<Signals> = {};

  const age = extractAge(trimmed, conversation);
  if (age !== undefined) {
    patch.deviceAgeMonths = age;
  }

  const condition = extractCondition(normalized, conversation);
  if (condition !== undefined) {
    patch.condition = condition;
    patch.problemText = trimmed.slice(0, 280);
  }

  const money = extractMoney(trimmed, conversation);
  if (money.owedCents !== undefined) {
    patch.owedCents = money.owedCents;
  }
  if (money.budgetCents !== undefined) {
    patch.budgetCents = money.budgetCents;
  }

  return patch;
}

const SHOPPER_KEYS = ["deviceAgeMonths", "condition", "problemText", "owedCents", "budgetCents"] as const;

/** Cart totals stay on the cart. Chat text cannot overwrite them. */
export function pickShopperSignals(patch: Partial<Signals>): Partial<Signals> {
  const picked: Partial<Signals> = {};
  for (const key of SHOPPER_KEYS) {
    const value = patch[key];
    if (value !== undefined) {
      assignShopperField(picked, key, value);
    }
  }
  return picked;
}

function assignShopperField(
  target: Partial<Signals>,
  key: (typeof SHOPPER_KEYS)[number],
  value: Signals[typeof key],
): void {
  switch (key) {
    case "deviceAgeMonths":
      if (typeof value === "number") {
        target.deviceAgeMonths = value;
      }
      return;
    case "condition":
      if (value === "fine" || value === "minor" || value === "broken" || value === "unusable") {
        target.condition = value;
      }
      return;
    case "problemText":
      if (typeof value === "string") {
        target.problemText = value;
      }
      return;
    case "owedCents":
      if (typeof value === "number") {
        target.owedCents = value;
      }
      return;
    case "budgetCents":
      if (typeof value === "number") {
        target.budgetCents = value;
      }
      return;
    default: {
      const unreachable: never = key;
      throw new Error(`Unhandled shopper field: ${String(unreachable)}`);
    }
  }
}

export function extractCartCode(text: string, options?: { allowBare?: boolean }): string | undefined {
  const labeled = text.match(/\bcart\s+([A-HJ-NP-Z2-9]{6})\b/i);
  const labeledCode = labeled?.[1];
  if (labeledCode) {
    return labeledCode.toUpperCase();
  }
  if (options?.allowBare === false) {
    return undefined;
  }
  const trimmed = text.trim();
  if (/^[A-HJ-NP-Z2-9]{6}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return undefined;
}

const MAX_AGE_MONTHS = 240;
const MAX_MONEY_CENTS = 10_000_000;

function extractAge(text: string, conversation: ConversationContext): number | undefined {
  const years = lastNumber(text, /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/gi);
  if (years !== undefined) {
    return clampAge(Math.round(years * 12));
  }
  const months = lastNumber(text, /(\d+(?:\.\d+)?)\s*(?:months?|mos?)\b/gi);
  if (months !== undefined) {
    return clampAge(Math.round(months));
  }
  if (/\ba couple (?:of )?years\b/i.test(text)) {
    return 24;
  }
  if (/\ba year\b/i.test(text)) {
    return 12;
  }
  if (conversation.step === "age" && /^\d+(?:\.\d+)?$/.test(text.trim())) {
    const bare = Number(text.trim());
    if (!Number.isFinite(bare)) {
      return undefined;
    }
    const asMonths = bare <= 6 ? Math.round(bare * 12) : Math.round(bare);
    return clampAge(asMonths);
  }
  return undefined;
}

function extractCondition(normalized: string, conversation: ConversationContext): Condition | undefined {
  if (
    /won'?t turn on|will not turn on|does(?:n'?t| not) turn on|bricked|water[- ]damage|waterlogged|unusable|no power|black screen/.test(
      normalized,
    )
  ) {
    return "unusable";
  }
  if (/\bdead\b/.test(normalized) && !/battery/.test(normalized)) {
    return "unusable";
  }
  if (
    /\b(cracked|cracks|crack|shattered|shatter|smashed|broken|battery|dies|dying|slow|storage|camera)\b/.test(
      normalized,
    )
  ) {
    return "broken";
  }
  if (/scratch|scuff|\bding\b|\bdent\b|\bworn\b/.test(normalized)) {
    return "minor";
  }
  if (
    /works fine|it'?s fine|it is fine|nothing wrong|no issues|all good|still works/.test(normalized) ||
    (conversation.step === "problem" && /^(fine|nothing|works|ok|okay|good)$/.test(normalized))
  ) {
    return "fine";
  }
  return undefined;
}

function extractMoney(
  text: string,
  conversation: ConversationContext,
): { owedCents?: number; budgetCents?: number } {
  const result: { owedCents?: number; budgetCents?: number } = {};
  const owedLabel = labeledMoney(text, /(?:owe|owed|owing|balance)\D{0,16}(\$?\d[\d,]*(?:\.\d{1,2})?)/i);
  const budgetLabel = labeledMoney(
    text,
    /(?:budget|spend|afford|max(?:imum)?)\D{0,20}(\$?\d[\d,]*(?:\.\d{1,2})?)/i,
  );
  if (owedLabel !== undefined) {
    result.owedCents = owedLabel;
  }
  if (budgetLabel !== undefined) {
    result.budgetCents = budgetLabel;
  }
  if (/paid off|nothing owed|owe nothing/.test(text.toLowerCase())) {
    result.owedCents = 0;
  }

  if (conversation.step === "owed" && result.owedCents === undefined) {
    const bare = bareMoney(text);
    if (bare !== undefined) {
      result.owedCents = bare;
    } else if (/^(nothing|none|zero)$/i.test(text.trim())) {
      result.owedCents = 0;
    }
  }
  if (conversation.step === "budget" && result.budgetCents === undefined) {
    const bare = bareMoney(text);
    if (bare !== undefined) {
      result.budgetCents = bare;
    }
  }
  return result;
}

function labeledMoney(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  const token = match?.[1];
  if (!token) {
    return undefined;
  }
  return parseMoneyToken(token);
}

function bareMoney(text: string): number | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?)?$/i);
  const token = match?.[1];
  if (!token) {
    return undefined;
  }
  return parseMoneyToken(token);
}

function parseMoneyToken(raw: string): number | undefined {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return undefined;
  }
  const [dollars, fraction = ""] = cleaned.split(".");
  if (dollars === undefined) {
    return undefined;
  }
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) {
    return undefined;
  }
  return cents;
}

function lastNumber(text: string, pattern: RegExp): number | undefined {
  const matches = text.matchAll(pattern);
  let value: number | undefined;
  for (const match of matches) {
    const token = match[1];
    if (token !== undefined) {
      value = Number(token);
    }
  }
  return value;
}

function clampAge(months: number): number | undefined {
  if (!Number.isInteger(months) || months < 0 || months > MAX_AGE_MONTHS) {
    return undefined;
  }
  return months;
}
