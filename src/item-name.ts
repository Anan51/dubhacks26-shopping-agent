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

/** How many distinct titles a bag post and the card list will carry. */
export const POSTED_ITEM_LIMIT = 5;

/**
 * Titles to send for a bag: cleanup, the 140-character cap, then de-dupe.
 * A later identical line does not consume another slot.
 */
export function postedItemNames(names: readonly string[], limit = POSTED_ITEM_LIMIT): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = capItemName(raw);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    unique.push(name);
    if (unique.length >= limit) {
      break;
    }
  }
  return unique;
}

/** Names the card lists, plus how many distinct titles sit past the cap. */
export function cartItemLines(names: readonly string[], limit = POSTED_ITEM_LIMIT): { shown: string[]; more: number } {
  const all = postedItemNames(names, Number.MAX_SAFE_INTEGER);
  if (all.length <= limit) {
    return { shown: all, more: 0 };
  }
  return { shown: all.slice(0, limit), more: all.length - limit };
}
