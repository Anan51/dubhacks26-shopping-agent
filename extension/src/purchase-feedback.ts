export type PurchaseFeedback = "regretted" | "kept" | null;

export function nextPurchaseFeedback(current: PurchaseFeedback, choice: "regretted" | "kept"): PurchaseFeedback {
  return current === choice ? null : choice;
}

export function purchaseHistoryBanner(rows: { isExample: boolean }[]): "Example data" | null {
  return rows.some((row) => row.isExample) ? "Example data" : null;
}
