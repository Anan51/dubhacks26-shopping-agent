const OPENS_IN_NEW_TAB = /\s*opens in a new tab\.?\s*$/i;

/** Collapse whitespace and drop Amazon's trailing screen-reader suffix. */
export function normalizeItemName(name: string): string {
  return name.replace(/\s+/g, " ").replace(OPENS_IN_NEW_TAB, "").trim();
}

/** Posted titles stay within this length. The cap is applied only after cleanup. */
export const ITEM_NAME_CAP = 140;

export function capItemName(name: string): string {
  const cleaned = normalizeItemName(name);
  if (cleaned.length <= ITEM_NAME_CAP) {
    return cleaned;
  }
  return cleaned.slice(0, ITEM_NAME_CAP).trim();
}
