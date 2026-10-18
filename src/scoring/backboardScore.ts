import mongoose from "mongoose";

import { readAccountConfig } from "../auth/config.js";
import { User } from "../auth/user.js";
import type { BackboardClient, MemorySearchHit } from "../memory/backboard.js";
import {
  categoryForItem,
  getBudgetProfile,
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
const RATIO_SPAN = 0.8;
const OVER_BUDGET_NUDGE = 0.5;
const LONG_HOURS_NUDGE = 0.4;
const GOAL_NUDGE = 0.3;

const WHY_REGRET = "You regretted a similar purchase before.";
const WHY_RATIO_UP = "More of your past buys were regrets.";
const WHY_BUDGET = "This costs more than your weekly budget.";
const WHY_HOURS = "This is more than a day's work.";
const WHY_GOAL = "This takes a bite out of a goal you saved.";

type Note = { weight: number; why: string };

/**
 * An unnecessary buy starts at exactly 4.5. Regret history can only raise that.
 * Kept purchases never lower it. A saved goal never makes it freer.
 * A necessary item stays at 4.5 no matter what is on file.
 * Example rows must already be removed by the caller.
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

  if (signals.ratedCount > 0 && signals.regretCount > 0) {
    const ratio = Math.min(1, signals.regretCount / signals.ratedCount);
    const nudge = (ratio - 0.5) * RATIO_SPAN;
    if (nudge > 0.05) {
      score += nudge;
      notes.push({ weight: nudge, why: WHY_RATIO_UP });
    }
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

export type ImpulseScoreOptions = {
  /**
   * Similar-regret search runs only when this is true.
   * Omitted follows `BACKBOARD_API_KEY`. Unset leaves price, hours, and necessity alone.
   */
  backboardEnabled?: boolean;
  /** The caller's Backboard client. Scoring never constructs one and never uses a client-supplied assistant id. */
  client?: BackboardClient;
  /** Bounds the search. A timeout or a thrown search leaves the regret signal at zero. */
  searchTimeoutMs?: number;
};

/** Enough hits to reach the similar-regret cap without a long wait. */
export const REGRET_SEARCH_LIMIT = 5;
/**
 * Live search often takes longer than 1.2s, so a real match used to time out
 * and leave the score at 4.5. 3.5s covers that. A timeout still returns no hits.
 * The search stays on the cart response: the score is part of the reply.
 */
export const REGRET_SEARCH_TIMEOUT_MS = 3_500;
/**
 * Backboard's search score is a distance: 0 is an identical memory.
 * After the category gate, a numeric score counts at or under 0.7,
 * and a distance around 0.88 or higher does not.
 * A same-item phone query scored about 0.44 and a Pixel query scored 0.578.
 * Pixel 9 keywords to phone, so that query matches an iPhone regret and 0.7 keeps it.
 */
export const DEFAULT_REGRET_SEARCH_MAX_DISTANCE = 0.7;

/**
 * Maximum distance for a Backboard search hit. Unset or outside [0, 1] uses 0.7.
 * A hit with no numeric score is not rejected here.
 */
export function regretSearchMaxDistance(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGRET_SEARCH_MAX_DISTANCE;
  if (typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_REGRET_SEARCH_MAX_DISTANCE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_REGRET_SEARCH_MAX_DISTANCE;
  }
  return parsed;
}

/**
 * Query for memories of regretted buys that resemble this bag.
 * Title and category together. Either one is enough when the other is blank.
 */
export function regretSearchQuery(item: string, category: string): string {
  const title = item.trim();
  const kind = category.trim();
  const query = title && kind ? `${title} ${kind}` : title || kind;
  return query.slice(0, 300);
}

/**
 * Reads the weekly budget, and, when Backboard is configured, a regret search plus saved goals.
 * Does not write. Does not count PurchaseRecords.
 * Necessary items skip the reads and stay at 4.5.
 * No assistant, no hits, or a failed search leaves the regret signal at zero.
 * Pass `budget` when the caller already loaded the profile so it is not read twice.
 */
export async function computeImpulseScore(
  userId: string,
  input: ImpulseItem,
  budget?: Pick<BudgetProfile, "weeklyBudget">,
  options?: ImpulseScoreOptions,
): Promise<ImpulseScore> {
  if (input.necessary || !shopperReadable(userId)) {
    return scoreFromSignals(input, EMPTY_IMPULSE_SIGNALS);
  }
  const category = input.category.trim().toLowerCase();
  const profile = budget ?? (await getBudgetProfile(userId));
  if (!memoryOn(options)) {
    return scoreFromSignals(
      { ...input, category },
      { ...EMPTY_IMPULSE_SIGNALS, weeklyBudget: profile.weeklyBudget },
    );
  }
  const [goals, categoryRegrets] = await Promise.all([
    getSavedGoals(userId),
    searchRegretWeight(userId, { ...input, category }, options),
  ]);
  return scoreFromSignals(
    { ...input, category },
    {
      weeklyBudget: profile.weeklyBudget,
      categoryRegrets,
      categoryKept: 0,
      regretCount: 0,
      ratedCount: 0,
      goals,
    },
  );
}

const NAME_STOPWORDS = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "from", "by", "at"]);

/**
 * Sum of closeness for regret hits that match this bag.
 * Callers pass the bag category. The cart path passes `categoryForItem(item)`.
 * A blank category falls back to that same mapping. It does not override the
 * name with a category the cart never stored.
 * A real category matches when the saved vote category or `categoryForItem`
 * of the memory subject equals the bag category. "other" is not a category
 * match. An "other" bag counts only when the names share a token.
 * The score is a distance, so it is only a second guard: a hit counts when
 * the distance is at most the maximum. A cross-category hit can still be close.
 * A missing score counts as one hit. Closeness is 1 minus the distance, so a
 * closer hit weighs more. Non-regret memories add nothing.
 */
function similarRegretWeight(
  hits: readonly MemorySearchHit[],
  maxDistance: number,
  bagItem: string,
  bagCategory: string,
): number {
  const supplied = bagCategory.trim().toLowerCase();
  const category = supplied.length > 0 ? supplied : categoryForItem(bagItem);
  let weight = 0;
  for (const hit of hits) {
    if (!isRegretContent(hit.content)) {
      continue;
    }
    if (!regretMatchesBag(category, bagItem, hit.content)) {
      continue;
    }
    if (!withinMaxDistance(hit.score, maxDistance)) {
      continue;
    }
    weight += hitCloseness(hit.score);
  }
  return weight;
}

/**
 * "other" is the catch-all, so it is not a category match. Two unrecognized
 * names count only when they share a token. A real category matches when the
 * saved vote category or `categoryForItem` of the subject equals the bag.
 * A Pixel 9 bag keywords to phone, so it lines up with an iPhone regret.
 */
function regretMatchesBag(bagCategory: string, bagItem: string, content: string): boolean {
  const subject = memorySubject(content);
  if (bagCategory === "other") return itemNamesOverlap(bagItem, subject);
  return categoryOfMemory(content) === bagCategory || categoryForItem(subject) === bagCategory;
}

/**
 * Search hits return content and a score, not metadata. The score is a
 * distance, where 0 is identical. A vote memory is already
 * `regretted purchase: {item} ({category}, {price})` from purchaseVoteLine.
 * The category inside those parentheses, the token before the first comma,
 * is used when it is present. An empty category, or a `Regret:` line with no
 * vote shape, is mapped with categoryForItem from its subject.
 */
function categoryOfMemory(content: string): string {
  const recorded = recordedVoteCategory(content);
  if (recorded) {
    return recorded;
  }
  return categoryForItem(memorySubject(content));
}

/** Category written by purchaseVoteLine, or null when the vote shape is absent. */
function recordedVoteCategory(content: string): string | null {
  const match = content.trim().match(/^regretted purchase:\s*.+\(([^)]*)\)\s*$/i);
  const inside = match?.[1];
  if (inside == null) {
    return null;
  }
  const comma = inside.indexOf(",");
  if (comma < 0) {
    return null;
  }
  const category = inside.slice(0, comma).trim().toLowerCase();
  return category.length > 0 ? category : null;
}

function itemNamesOverlap(bagItem: string, rememberedItem: string): boolean {
  const remembered = nameTokens(rememberedItem);
  for (const token of nameTokens(bagItem)) {
    if (remembered.has(token)) {
      return true;
    }
  }
  return false;
}

function nameTokens(name: string): Set<string> {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !NAME_STOPWORDS.has(token));
  return new Set(tokens);
}

function memorySubject(content: string): string {
  const trimmed = content.trim();
  const vote = trimmed.match(/^regretted purchase:\s*(.+?)\s+\([^)]*\)\s*$/i);
  if (vote?.[1]?.trim()) {
    return vote[1].trim();
  }
  const prefixed = trimmed.match(/^regret:\s*(.+)$/i);
  if (prefixed?.[1]?.trim()) {
    return prefixed[1].trim();
  }
  return trimmed;
}

function memoryOn(options: ImpulseScoreOptions | undefined): boolean {
  return options?.backboardEnabled ?? readAccountConfig().backboardEnabled;
}

async function searchRegretWeight(
  userId: string,
  input: ImpulseItem,
  options: ImpulseScoreOptions | undefined,
): Promise<number> {
  const client = options?.client;
  const query = regretSearchQuery(input.item, input.category);
  if (!client || !query) {
    return 0;
  }
  try {
    const assistantId = await readAssistantId(userId);
    if (!assistantId) {
      return 0;
    }
    const hits = await searchWithin(
      client,
      assistantId,
      query,
      REGRET_SEARCH_LIMIT,
      options?.searchTimeoutMs ?? REGRET_SEARCH_TIMEOUT_MS,
    );
    return similarRegretWeight(hits, regretSearchMaxDistance(), input.item, input.category);
  } catch {
    return 0;
  }
}

async function readAssistantId(userId: string): Promise<string | null> {
  const user = await User.findById(userId).select("backboardAssistantId");
  const assistantId = user?.backboardAssistantId;
  return typeof assistantId === "string" && assistantId.trim().length > 0 ? assistantId.trim() : null;
}

async function searchWithin(
  client: BackboardClient,
  assistantId: string,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<MemorySearchHit[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hits = await Promise.race([
      client.searchMemories(assistantId, query, limit),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Backboard search timed out.")), timeoutMs);
      }),
    ]);
    return Array.isArray(hits) ? hits : [];
  } catch {
    return [];
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function withinMaxDistance(score: number | null, maxDistance: number): boolean {
  if (score == null || !Number.isFinite(score)) {
    return true;
  }
  return score <= maxDistance;
}

function isRegretContent(content: string): boolean {
  const text = content.trim().toLowerCase();
  return text.startsWith("regret:") || text.includes("regretted purchase:");
}

/** Distance 0 is identical, so closeness is 1 minus the distance. A missing score counts as one hit. */
function hitCloseness(score: number | null): number {
  if (score == null || !Number.isFinite(score)) {
    return 1;
  }
  const closeness = 1 - score;
  return Math.min(1, Math.max(0, closeness));
}

function competesWithGoal(price: number, goals: readonly SavedGoal[]): boolean {
  return goals.some((goal) => goal.targetAmount != null && goal.targetAmount > 0 && price >= goal.targetAmount * 0.5);
}

function shopperReadable(userId: string): boolean {
  return /^[a-f0-9]{24}$/i.test(userId) && mongoose.connection.readyState === 1;
}
