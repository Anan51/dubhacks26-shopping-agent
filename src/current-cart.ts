import type { Cart } from "./types.js";

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
