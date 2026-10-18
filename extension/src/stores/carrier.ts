import type { CarrierFacts } from "../../../src/scoring/carrierSwitch.js";
import { isLocalCarrierFixture } from "../../../src/sites.js";
import type { Bag, StoreAdapter } from "./adapter.js";

/** Plan fields on the local fixture. Not a live carrier checkout. */
export const CARRIER_FIELDS = {
  plan: "#carrier-plan",
  currentMonthly: "[data-carrier='current-monthly']",
  newMonthly: "[data-carrier='new-monthly']",
  balance: "[data-carrier='balance']",
  months: "[data-carrier='months']",
  fee: "[data-carrier='fee']",
  switchButton: "#switch",
} as const;

const SWITCH_LABEL = /^(switch|confirm)$/i;

/** Same chrome the Apple and Amazon adapters refuse to dim. */
const SITE_CHROME = "nav, header, footer, [role='banner'], [role='contentinfo']";

export const CARRIER_ITEM_NAME = "Switch to Verizon";

export const carrierAdapter: StoreAdapter = {
  id: "carrier",
  match(loc) {
    return isLocalCarrierFixture(loc.href);
  },
  readBag(doc) {
    const facts = readCarrierFacts(doc);
    if (!facts) {
      return null;
    }
    const bag: Bag = {
      items: [{ item: CARRIER_ITEM_NAME, price: facts.newMonthlyCents, category: "plan" }],
      total: facts.newMonthlyCents,
      carrier: facts,
    };
    return bag;
  },
  checkoutButtons(doc) {
    const htmlElement = doc.defaultView?.HTMLElement;
    const seen = new Set<HTMLElement>();
    if (!htmlElement) {
      return [];
    }
    const add = (node: Element) => {
      if (!(node instanceof htmlElement) || node.closest(SITE_CHROME) || seen.has(node)) {
        return;
      }
      seen.add(node);
    };
    const named = doc.querySelector(CARRIER_FIELDS.switchButton);
    if (named) {
      add(named);
    }
    for (const node of doc.querySelectorAll("button, a, input, [role='button']")) {
      if (isSwitchLabel(node)) {
        add(node);
      }
    }
    return [...seen];
  },
  isOrderConfirmation() {
    return false;
  },
};

/** Reads the five plan signals. Null when any one is missing or not a number. */
export function readCarrierFacts(doc: Document): CarrierFacts | null {
  const currentMonthlyCents = parseCarrierCents(textAt(doc, CARRIER_FIELDS.currentMonthly));
  const newMonthlyCents = parseCarrierCents(textAt(doc, CARRIER_FIELDS.newMonthly));
  const balanceCents = parseCarrierCents(textAt(doc, CARRIER_FIELDS.balance));
  const feeCents = parseCarrierCents(textAt(doc, CARRIER_FIELDS.fee));
  const monthsLeft = parseMonthCount(textAt(doc, CARRIER_FIELDS.months));
  if (
    currentMonthlyCents === null ||
    currentMonthlyCents <= 0 ||
    newMonthlyCents === null ||
    newMonthlyCents <= 0 ||
    balanceCents === null ||
    feeCents === null ||
    monthsLeft === null
  ) {
    return null;
  }
  return { currentMonthlyCents, newMonthlyCents, balanceCents, monthsLeft, feeCents };
}

/** Reads a currency string such as "$80.00" into integer cents. */
export function parseCarrierCents(text: string): number | null {
  const match = text.replace(/\u00a0/g, " ").match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match?.[0]) {
    return null;
  }
  const dollars = Number(match[0].replace(/,/g, ""));
  if (!Number.isFinite(dollars)) {
    return null;
  }
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) {
    return null;
  }
  return cents;
}

function textAt(doc: Document, selector: string): string {
  return doc.querySelector(selector)?.textContent ?? "";
}

function parseMonthCount(text: string): number | null {
  const match = text.match(/\d+/);
  if (!match?.[0]) {
    return null;
  }
  const months = Number(match[0]);
  if (!Number.isSafeInteger(months) || months < 0 || months > 120) {
    return null;
  }
  return months;
}

function isSwitchLabel(node: Element): boolean {
  const value = (node.getAttribute("value") ?? "").replace(/\s+/g, " ").trim();
  const aria = (node.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
  if (SWITCH_LABEL.test(value) || SWITCH_LABEL.test(aria)) {
    return true;
  }
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length <= 40 && SWITCH_LABEL.test(text);
}
