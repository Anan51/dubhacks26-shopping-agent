import type { Cart } from "./types.js";

/** Account owner. Absent on anonymous demo carts. Not part of Decision. */
export function readAuthUserId(cart: Cart): string | undefined {
  const value = (cart as Cart & { authUserId?: unknown }).authUserId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function assignAuthUser(cart: Cart, authUserId: string): void {
  (cart as Cart & { authUserId?: string }).authUserId = authUserId;
}

/**
 * A signed-in read is that account's cart. With no account, the cart stays
 * readable so demo mode and the desk can still load a code.
 */
export function cartReadableBy(cart: Cart, authUserId: string | null): boolean {
  if (!authUserId) {
    return true;
  }
  return readAuthUserId(cart) === authUserId;
}

/**
 * Signed-in lists are that account's carts. A mismatched ?userId is refused.
 * With no account, anonymous carts keep the per-device list. Owned carts stay out.
 */
export function scopedCarts(
  carts: readonly Cart[],
  authUserId: string | null,
  queryUserId: string | null,
): { ok: true; carts: Cart[] } | { ok: false } {
  if (authUserId) {
    if (queryUserId && queryUserId !== authUserId) {
      return { ok: false };
    }
    return { ok: true, carts: currentCarts(carts.filter((cart) => cartReadableBy(cart, authUserId))) };
  }
  return {
    ok: true,
    carts: currentCarts(
      carts.filter((cart) => readAuthUserId(cart) === undefined),
      queryUserId,
    ),
  };
}

/**
 * One bag per shopper: the newest cart for that user.
 * Earlier sessions stay in the store but drop off the desk and the popup.
 */
export function currentCarts(carts: readonly Cart[], userId: string | null = null): Cart[] {
  const newest = new Map<string, Cart>();
  const ordered = [...carts].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.code.localeCompare(right.code));
  for (const cart of ordered) {
    newest.set(cart.userId ?? "", cart);
  }
  if (userId) {
    const cart = newest.get(userId);
    return cart ? [cart] : [];
  }
  return [...newest.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.code.localeCompare(left.code));
}
