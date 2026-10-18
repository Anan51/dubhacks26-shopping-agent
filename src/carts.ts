import { alternativeById, alternativeItem } from "./alternatives.js";
import { shouldLock } from "./guard.js";
import type { Cart, CartItem, Signals } from "./types.js";

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

export function withCartFacts(partial: Partial<Signals>, items: readonly CartItem[]): Signals {
  if (
    partial.deviceAgeMonths === undefined ||
    partial.condition === undefined ||
    partial.owedCents === undefined ||
    partial.budgetCents === undefined
  ) {
    throw new Error("Shopper signals are incomplete.");
  }
  return {
    deviceAgeMonths: partial.deviceAgeMonths,
    condition: partial.condition,
    problemText: partial.problemText ?? "",
    owedCents: partial.owedCents,
    budgetCents: partial.budgetCents,
    problems: partial.problems ?? [],
    dueTodayCents: dueTodayCents(items),
    phonePriceCents: phonePriceCents(items),
    monthlyPlanCents: monthlyPlanCents(items),
  };
}

export function createCart(input: {
  items: CartItem[];
  now: Date;
  demo: boolean;
  coolingMs: number;
  lockThresholdCents: number;
  guardEnabled: boolean;
  /** False completes the synthetic order immediately. */
  lock: boolean;
  code?: string;
  taken?: (code: string) => boolean;
}): Cart {
  if (!input.items.some((item) => item.kind === "phone")) {
    throw new Error("Choose a phone before buying.");
  }
  const code = input.code ?? uniqueCode(input.taken);
  const createdAt = input.now.toISOString();
  const cart: Cart = {
    code,
    items: input.items,
    createdAt,
    status: "cooling",
    coolingOffEndsAt: new Date(input.now.getTime() + input.coolingMs).toISOString(),
    coolingMs: input.coolingMs,
    lockThresholdCents: input.lockThresholdCents,
    guardEnabled: input.guardEnabled,
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
    orderId: null,
    completedAt: null,
    buyAnywayAt: null,
    signalSource: null,
    selectedAlternativeId: null,
  };
  if (!input.lock) {
    cart.status = "completed";
    cart.orderId = `WM-${code.slice(0, 4)}`;
    cart.completedAt = createdAt;
    cart.coolingOffEndsAt = createdAt;
  }
  return cart;
}

/** Shared unlock for chat confirmation and Buy anyway. */
export function completeOrder(cart: Cart, now: Date, source: "chat" | "buy-anyway"): Cart {
  if (cart.status === "completed") {
    return cart;
  }
  cart.status = "completed";
  cart.orderId = `WM-${cart.code.slice(0, 4)}`;
  cart.completedAt = now.toISOString();
  cart.reminderFireAt = null;
  if (source === "buy-anyway") {
    cart.buyAnywayAt = now.toISOString();
  }
  return cart;
}

export function switchToAlternative(cart: Cart, alternativeId: string, now: Date): Cart {
  const alternative = alternativeById(alternativeId);
  if (!alternative) {
    throw new Error("Unknown alternative.");
  }
  cart.items = [alternativeItem(alternative)];
  cart.selectedAlternativeId = alternative.id;
  if (
    !shouldLock({
      enabled: cart.guardEnabled,
      dueTodayCents: alternative.priceCents,
      thresholdCents: cart.lockThresholdCents,
    })
  ) {
    completeOrder(cart, now, "chat");
  }
  return cart;
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
