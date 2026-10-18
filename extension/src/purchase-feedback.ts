export type PurchaseFeedback = "regretted" | "kept" | null;

export function nextPurchaseFeedback(current: PurchaseFeedback, choice: "regretted" | "kept"): PurchaseFeedback {
  return current === choice ? null : choice;
}
