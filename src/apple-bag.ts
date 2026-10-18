import type { ApplePage } from "./sites.js";

export const FALLBACK_TOTAL_CENTS = 120_000;
export const FALLBACK_ITEM_NAME = "Example phone";

export type BagControl = {
  tag: string;
  text: string;
  ariaLabel: string;
};

export type InterpretedBag = {
  itemNames: string[];
  totalCents: number | null;
  parsed: boolean;
};

const TOTAL_LABEL = /^(bag subtotal|subtotal|order total|estimated total|total)$/i;
const SKIP_LINE =
  /^(remove|save for later|edit|quantity|qty|shopping bag|your bag|bag|check out|apple pay|continue|free|shipping|estimated tax|tax|included|sign in|apple)$/i;

/** The bag total and the first product name. Nothing else on the page is kept. */
export function interpretBag(lines: readonly string[]): InterpretedBag {
  const cleaned = lines.map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length > 0);
  const totalCents = findTotal(cleaned);
  const named = findItemNames(cleaned)[0] ?? productTitle(cleaned);
  return {
    itemNames: named ? [named] : [],
    totalCents,
    parsed: totalCents !== null && totalCents > 0,
  };
}

/** A readable bag. An unreadable page does not become the example phone. */
export function readableBag(interpreted: InterpretedBag): { itemNames: string[]; totalCents: number; parsed: true } | null {
  if (!interpreted.parsed || interpreted.totalCents == null || interpreted.totalCents <= 0 || interpreted.itemNames.length === 0) {
    return null;
  }
  return { itemNames: interpreted.itemNames, totalCents: interpreted.totalCents, parsed: true };
}

export function isApplePayControl(control: BagControl): boolean {
  const tag = control.tag.toLowerCase();
  if (tag === "apple-pay-button") {
    return true;
  }
  // A footer "Apple Pay" link is an anchor, not the checkout button.
  if (tag === "a") {
    return false;
  }
  return /apple\s*pay\b|\s*pay\b/i.test(controlBlob(control));
}

/** Apple Card on a checkout control. Informational links stay open. */
export function isAppleCardCheckout(control: BagControl): boolean {
  if (control.tag.toLowerCase() === "a") {
    return false;
  }
  const blob = controlBlob(control);
  return /\bapple\s*card\b/i.test(blob) && /\b(check\s*out|pay)\b/i.test(blob);
}

/** Collapse every whitespace run, then compare the whole label. A longer promo stays open. */
function normalizePayLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whole label only, after whitespace is collapsed.
 * checkout, check out, check out now, and the same labels with Apple Pay.
 * "Learn about checkout" and "Checkout tips" stay open.
 */
function isExactCheckOutLabel(value: string): boolean {
  return /^check\s*out(?: now)?(?: with (?:apple pay|\s*pay))?$/.test(value);
}

export function isCheckOutControl(control: BagControl): boolean {
  const text = normalizePayLabel(control.text);
  const label = normalizePayLabel(control.ariaLabel);
  return isExactCheckOutLabel(text) || isExactCheckOutLabel(label);
}

/** Checkout and Apple Pay on the bag. On the checkout host, also the pay and continue controls. */
export function isBlockedControl(control: BagControl, page: ApplePage): boolean {
  if (isApplePayControl(control) || isCheckOutControl(control) || isAppleCardCheckout(control)) {
    return true;
  }
  if (page !== "checkout") {
    return false;
  }
  return /^(place your order|pay|pay now|continue)$/i.test(control.text.trim());
}

export function parsePriceCents(line: string): number | null {
  const match = line.trim().match(/(?:^|\s)\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?\s*$/);
  const dollarsRaw = match?.[1];
  if (!dollarsRaw) {
    return null;
  }
  const dollars = Number(dollarsRaw.replace(/,/g, ""));
  const fraction = Number(match?.[2] ?? "0");
  if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(fraction)) {
    return null;
  }
  const cents = dollars * 100 + fraction;
  if (cents < 0 || cents > 10_000_000) {
    return null;
  }
  return cents;
}

function findTotal(lines: readonly string[]): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !isTotalLabel(line)) {
      continue;
    }
    const inline = priceOnly(line) ?? embeddedPrice(line);
    if (inline !== null) {
      return inline;
    }
    for (let look = 1; look <= 2; look += 1) {
      const next = lines[index + look];
      if (next === undefined) {
        break;
      }
      const price = priceOnly(next);
      if (price !== null) {
        return price;
      }
    }
  }
  return null;
}

function productTitle(lines: readonly string[]): string | null {
  const totalIndex = lines.findIndex((line) => isTotalLabel(line));
  if (totalIndex < 0) {
    return null;
  }
  const region = lines.slice(Math.max(0, totalIndex - 40), totalIndex);
  const counts = new Map<string, number>();
  for (const line of region) {
    if (!isTitleCandidate(line)) {
      continue;
    }
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [line, count] of counts) {
    if (count > bestCount) {
      best = line;
      bestCount = count;
    }
  }
  return best ?? nameBeforeTotal(lines);
}

function isTitleCandidate(line: string): boolean {
  if (line.length < 3 || line.length > 80) {
    return false;
  }
  if (SKIP_LINE.test(line) || priceOnly(line) !== null || isTotalLabel(line) || /^\d+$/.test(line)) {
    return false;
  }
  if (/[.!?]/.test(line) || /@|zip code|footnote|learn more|quantity/i.test(line) || line.startsWith("$")) {
    return false;
  }
  return true;
}

function nameBeforeTotal(lines: readonly string[]): string | null {
  const totalIndex = lines.findIndex((line) => isTotalLabel(line));
  if (totalIndex < 0) {
    return null;
  }
  for (let index = totalIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || SKIP_LINE.test(line) || priceOnly(line) !== null || isTotalLabel(line)) {
      continue;
    }
    if (line.length > 140 || line.includes("@")) {
      continue;
    }
    return line;
  }
  return null;
}

function findItemNames(lines: readonly string[]): string[] {
  const names: string[] = [];
  const totalIndex = lines.findIndex((line) => isTotalLabel(line));
  const end = totalIndex === -1 ? lines.length : totalIndex;
  for (let index = 0; index < end; index += 1) {
    const line = lines[index];
    if (line === undefined || priceOnly(line) === null || belongsToSummary(lines, index)) {
      continue;
    }
    const name = lookBackName(lines, index);
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function lookBackName(lines: readonly string[], priceIndex: number): string | null {
  for (let look = 1; look <= 4; look += 1) {
    const line = lines[priceIndex - look];
    if (line === undefined) {
      break;
    }
    if (priceOnly(line) !== null || isTotalLabel(line) || SKIP_LINE.test(line) || /^\d+\s*(gb|tb)\b/i.test(line)) {
      continue;
    }
    if (line.includes("@") || /\d{3}[-.\s]\d{3}/.test(line)) {
      continue;
    }
    if (line.length > 140) {
      continue;
    }
    return line;
  }
  return null;
}

function belongsToSummary(lines: readonly string[], priceIndex: number): boolean {
  for (let look = 1; look <= 2; look += 1) {
    const line = lines[priceIndex - look];
    if (line === undefined) {
      break;
    }
    if (isTotalLabel(line) || /^(shipping|estimated tax|tax)$/i.test(line)) {
      return true;
    }
    if (priceOnly(line) === null && !SKIP_LINE.test(line)) {
      return false;
    }
  }
  return false;
}

function isTotalLabel(line: string): boolean {
  return TOTAL_LABEL.test(line.replace(/\$[\d,.]+/, "").trim());
}

function priceOnly(line: string): number | null {
  if (!/^\$\s*[\d,]+(?:\.\d{2})?$/.test(line.trim())) {
    return null;
  }
  return parsePriceCents(line);
}

function embeddedPrice(line: string): number | null {
  if (priceOnly(line) !== null) {
    return priceOnly(line);
  }
  if (!/\$\s*\d/.test(line)) {
    return null;
  }
  return parsePriceCents(line);
}

function controlBlob(control: BagControl): string {
  return `${control.text} ${control.ariaLabel}`.replace(/\s+/g, " ").trim();
}
