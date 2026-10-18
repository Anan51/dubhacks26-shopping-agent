export type LockPhase = "wait-reply" | "can-unlock" | "open";

export function lockPhase(cart: { replied: boolean; isUnlocked: boolean; necessity?: string | null }): LockPhase {
  if (cart.necessity === "necessary" || cart.isUnlocked) {
    return "open";
  }
  if (cart.replied) {
    return "can-unlock";
  }
  return "wait-reply";
}
