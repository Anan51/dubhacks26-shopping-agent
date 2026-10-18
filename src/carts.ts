import { EXAMPLE_DEVICE_AGE_MONTHS, EXAMPLE_OWED_CENTS } from "./heuristic.js";
import type { Cart, CartItem, Signals } from "./types.js";

/** Used when the Apple bag cannot be read. Labeled example data in the UI. */
export const FALLBACK_TOTAL_CENTS = 120_000;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCartCode(rng: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    const char = ALPHABET[Math.floor(rng() * ALPHABET.length)];
    if (!char) {
      throw new Error("Cart code alphabet missed.");
    }
    code += char;
  }
  return code;
}

export function dueTodayCents(items: readonly CartItem[]): number {
  return items.filter((item) => item.cadence === "once").reduce((sum, item) => sum + item.priceCents, 0);
}

export function phonePriceCents(items: readonly CartItem[]): number {
  return items.filter((item) => item.kind === "phone").reduce((sum, item) => sum + item.priceCents, 0);
}

export function monthlyPlanCents(items: readonly CartItem[]): number {
  return items.filter((item) => item.cadence === "monthly").reduce((sum, item) => sum + item.priceCents, 0);
}

/** Missing age and balance use labeled example data. There is no survey. */
export function withCartFacts(partial: Partial<Signals>, totalCents: number): Signals {
  return {
    deviceAgeMonths: partial.deviceAgeMonths ?? EXAMPLE_DEVICE_AGE_MONTHS,
    condition: partial.condition ?? "fine",
    problemText: partial.problemText ?? "",
    needVsWant: partial.needVsWant ?? "unknown",
    urgency: partial.urgency ?? "medium",
    currentPhoneBroken: partial.currentPhoneBroken ?? false,
    reasonText: partial.reasonText ?? "",
    owedCents: partial.owedCents ?? EXAMPLE_OWED_CENTS,
    budgetCents: partial.budgetCents ?? 0,
    problems: partial.problems ?? [],
    dueTodayCents: totalCents,
    phonePriceCents: totalCents,
    monthlyPlanCents: 0,
  };
}

export function bagFingerprint(userId: string, names: readonly string[], totalCents: number): string {
  const titles = names.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0).sort();
  return `${userId}|${totalCents}|${titles.join("|")}`;
}

export function itemsForBag(names: readonly string[], totalCents: number, parsed: boolean): CartItem[] {
  const detail = parsed ? "Read from the Apple bag" : "Synthetic fallback. The Apple bag could not be read.";
  const list = names.map((name) => name.trim()).filter((name) => name.length > 0);
  const titles = list.length > 0 ? list : [parsed ? "Apple bag" : "Example phone"];
  return titles.map((name, index) => ({
    id: `bag-${index}`,
    kind: index === 0 ? "phone" : "accessory",
    name,
    detail,
    priceCents: index === 0 ? totalCents : 0,
    cadence: "once" as const,
  }));
}

export const VAULT_MS = 24 * 60 * 60 * 1000;

export function startLockedCart(input: {
  items: CartItem[];
  totalCents: number;
  parsedFromPage: boolean;
  pageHost: string | null;
  fingerprint: string;
  now: Date;
  demo: boolean;
  lockMs: number;
  userId: string | null;
  code?: string;
  taken?: (code: string) => boolean;
}): Cart {
  const code = input.code ?? uniqueCode(input.taken);
  const createdAt = input.now.toISOString();
  return {
    code,
    items: input.items,
    totalCents: input.totalCents,
    parsedFromPage: input.parsedFromPage,
    pageHost: input.pageHost,
    fingerprint: input.fingerprint,
    createdAt,
    status: "locked",
    demo: input.demo,
    signals: {},
    decision: null,
    explanation: null,
    reminderAt: null,
    reminderFireAt: null,
    reminderSentAt: null,
    conversationId: null,
    agentSenderId: null,
    lastInboundMessageId: null,
    isUnlocked: false,
    lockStartedAt: createdAt,
    lockEndsAt: new Date(input.now.getTime() + input.lockMs).toISOString(),
    vaultUntil: null,
    vaultMode: null,
    necessity: null,
    necessitySource: null,
    necessityReason: null,
    personaId: null,
    userImpulseScore: null,
    justificationGrade: null,
    gradeSource: null,
    gradeReason: null,
    purchaseScore: null,
    scoreBucket: null,
    scoreReason: null,
    signalSource: null,
    motiveSources: null,
    reading: false,
    userId: input.userId,
    lastPing: null,
  };
}

/** Clears a vault and opens checkout. Does not ask whether the vault was enforced. */
export function liftCart(cart: Cart): Cart {
  cart.vaultUntil = null;
  cart.vaultMode = null;
  cart.isUnlocked = true;
  cart.status = "unlocked";
  return cart;
}

export function isEnforcedVault(cart: Cart, now: Date): boolean {
  return isVaultActive(cart, now) && cart.vaultMode !== "soft";
}

export function unlockCart(cart: Cart, now: Date = new Date()): Cart {
  if (isEnforcedVault(cart, now)) {
    return cart;
  }
  return liftCart(cart);
}

export function sleepCart(
  cart: Cart,
  now: Date,
  vaultMs: number = VAULT_MS,
  demoReminderMs: number = 60_000,
  mode: "enforced" | "soft" = "enforced",
): Cart {
  cart.isUnlocked = false;
  cart.status = "vault";
  cart.vaultMode = mode;
  cart.vaultUntil = new Date(now.getTime() + vaultMs).toISOString();
  cart.reminderAt = cart.vaultUntil;
  cart.reminderFireAt = cart.demo ? new Date(now.getTime() + demoReminderMs).toISOString() : cart.vaultUntil;
  cart.reminderSentAt = null;
  return cart;
}

export function skipVault(cart: Cart, now: Date): Cart {
  cart.vaultUntil = now.toISOString();
  if (cart.status === "vault") {
    cart.status = "locked";
  }
  return cart;
}

export function isVaultActive(cart: Cart, now: Date): boolean {
  return cart.vaultUntil !== null && Date.parse(cart.vaultUntil) > now.getTime();
}

export type LockGate =
  | { ok: true; httpStatus: 200; isUnlocked: true; reason: null; vaultUntil: null; cartStatus: Cart["status"] }
  | {
      ok: false;
      httpStatus: 423;
      isUnlocked: false;
      reason: "locked" | "vault";
      vaultUntil: string | null;
      cartStatus: Cart["status"];
    };

/** Lock-state check for /dev. Does not place an order or change the cart. */
export function lockState(cart: Cart, now: Date): LockGate {
  if (isVaultActive(cart, now)) {
    return {
      ok: false,
      httpStatus: 423,
      isUnlocked: false,
      reason: "vault",
      vaultUntil: cart.vaultUntil,
      cartStatus: cart.status,
    };
  }
  if (!cart.isUnlocked) {
    return {
      ok: false,
      httpStatus: 423,
      isUnlocked: false,
      reason: "locked",
      vaultUntil: null,
      cartStatus: cart.status,
    };
  }
  return { ok: true, httpStatus: 200, isUnlocked: true, reason: null, vaultUntil: null, cartStatus: cart.status };
}

function uniqueCode(taken: ((code: string) => boolean) | undefined): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateCartCode();
    if (!taken?.(code)) {
      return code;
    }
  }
  throw new Error("Could not allocate a cart code.");
}
