import { grokChat, DEFAULT_XAI_MODEL } from "./grok.js";
import type { Condition, ConversationContext, ProblemTag, SignalSource, Signals } from "./types.js";

const PROBLEM_TAGS: readonly ProblemTag[] = ["battery", "screen", "performance", "cost"];

export type Extraction = {
  signals: Partial<Signals>;
  source: SignalSource;
};

export type ExtractOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Keyword parse, then an optional Grok JSON parse. Valid model fields override
 * keywords; problem tags are the sorted union. No key, a bad response, or
 * invalid JSON keeps the keyword result.
 */
export async function extractSignals(
  text: string,
  conversation: ConversationContext,
  options: ExtractOptions = {},
): Promise<Extraction> {
  const keyword = keywordExtract(text, conversation);
  const llm = await grokExtract(text, conversation, options);
  if (!llm) {
    return { signals: keyword, source: "keywords" };
  }
  return { signals: mergeSignalPatches(keyword, llm), source: "grok" };
}

function keywordExtract(text: string, conversation: ConversationContext): Partial<Signals> {
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

  const problems = extractProblems(normalized);
  if (problems.length > 0) {
    patch.problems = problems;
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

const SHOPPER_KEYS = ["deviceAgeMonths", "condition", "problemText", "problems", "owedCents", "budgetCents"] as const;

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
    case "problems":
      if (Array.isArray(value)) {
        target.problems = value.filter((tag): tag is ProblemTag => PROBLEM_TAGS.includes(tag as ProblemTag));
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

function extractProblems(normalized: string): ProblemTag[] {
  const found = new Set<ProblemTag>();
  if (/\b(battery|dies|dying)\b/.test(normalized)) {
    found.add("battery");
  }
  if (/\b(cracked|cracks|crack|shattered|shatter|smashed|screen)\b/.test(normalized)) {
    found.add("screen");
  }
  if (/\b(slow|storage|camera|lag)\b/.test(normalized)) {
    found.add("performance");
  }
  if (/\b(too expensive|cheaper plan|can't afford|cannot afford|bill is high)\b/.test(normalized)) {
    found.add("cost");
  }
  return PROBLEM_TAGS.filter((tag) => found.has(tag));
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

export function mergeSignalPatches(keyword: Partial<Signals>, llm: Partial<Signals>): Partial<Signals> {
  const merged: Partial<Signals> = { ...keyword, ...stripEmpty(llm) };
  const problems = uniqueProblems([...(keyword.problems ?? []), ...(llm.problems ?? [])]);
  if (problems.length > 0) {
    merged.problems = problems;
  }
  return merged;
}

/** Parse a Grok message body into shopper signals. Invalid JSON or no usable fields returns null. */
export function parseGrokSignalJson(raw: string): Partial<Signals> | null {
  const trimmed = unwrapJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const patch: Partial<Signals> = {};
  if (typeof parsed.deviceAgeMonths === "number" && Number.isInteger(parsed.deviceAgeMonths)) {
    const age = clampAge(parsed.deviceAgeMonths);
    if (age !== undefined) {
      patch.deviceAgeMonths = age;
    }
  }
  if (parsed.condition === "fine" || parsed.condition === "minor" || parsed.condition === "broken" || parsed.condition === "unusable") {
    patch.condition = parsed.condition;
  }
  if (typeof parsed.problemText === "string" && parsed.problemText.trim().length > 0) {
    patch.problemText = parsed.problemText.trim().slice(0, 280);
  }
  if (Array.isArray(parsed.problems)) {
    const problems = uniqueProblems(parsed.problems.filter((tag): tag is ProblemTag => PROBLEM_TAGS.includes(tag as ProblemTag)));
    if (problems.length > 0) {
      patch.problems = problems;
    }
  }
  if (typeof parsed.owedCents === "number" && Number.isInteger(parsed.owedCents) && parsed.owedCents >= 0 && parsed.owedCents <= MAX_MONEY_CENTS) {
    patch.owedCents = parsed.owedCents;
  }
  if (typeof parsed.budgetCents === "number" && Number.isInteger(parsed.budgetCents) && parsed.budgetCents >= 0 && parsed.budgetCents <= MAX_MONEY_CENTS) {
    patch.budgetCents = parsed.budgetCents;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

async function grokExtract(text: string, conversation: ConversationContext, options: ExtractOptions): Promise<Partial<Signals> | null> {
  if (!options.apiKey) {
    return null;
  }
  const prompt = [
    "Extract shopper signals from this phone-upgrade chat message.",
    "Reply with JSON only, no markdown.",
    'Keys: deviceAgeMonths (integer months or null), condition ("fine"|"minor"|"broken"|"unusable" or null), problems (array of "battery"|"screen"|"performance"|"cost"), problemText (string or null), owedCents (integer cents or null), budgetCents (integer cents or null).',
    "Map a battery that dies during the day to problems [\"battery\"] and condition \"broken\".",
    `The question we asked was: ${conversation.step}.`,
    "",
    text,
  ].join("\n");
  const raw = await grokChat({
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_XAI_MODEL,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    prompt,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (!raw) {
    return null;
  }
  return parseGrokSignalJson(raw);
}

function stripEmpty(patch: Partial<Signals>): Partial<Signals> {
  const next: Partial<Signals> = {};
  if (patch.deviceAgeMonths !== undefined) {
    next.deviceAgeMonths = patch.deviceAgeMonths;
  }
  if (patch.condition !== undefined) {
    next.condition = patch.condition;
  }
  if (patch.problemText !== undefined && patch.problemText.length > 0) {
    next.problemText = patch.problemText;
  }
  if (patch.owedCents !== undefined) {
    next.owedCents = patch.owedCents;
  }
  if (patch.budgetCents !== undefined) {
    next.budgetCents = patch.budgetCents;
  }
  return next;
}

function uniqueProblems(tags: readonly ProblemTag[]): ProblemTag[] {
  return PROBLEM_TAGS.filter((tag) => tags.includes(tag));
}

/** Pull a JSON object out of a reply, including one wrapped in ```json fences. */
export function unwrapJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return body.slice(start, end + 1);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
