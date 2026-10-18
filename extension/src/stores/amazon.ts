import { normalizeItemName } from "../../../src/item-name.js";
import { isLocalAmazonFixture } from "../../../src/sites.js";
import type { Bag, BagItem, StoreAdapter } from "./adapter.js";

/**
 * Cart selectors. Amazon rewrites this markup; keep every selector in this block.
 * Struck list prices use data-a-strike and must not win.
 */
export const AMAZON_SELECTORS = {
  cart: "#sc-active-cart",
  lineItem: "[data-asin].sc-list-item",
  title: ".sc-product-title, .a-truncate-full",
  price: ".a-price:not([data-a-strike]) .a-offscreen",
  legacyPrice: ".sc-product-price",
  subtotal: "#sc-subtotal-amount-activecart .a-offscreen, #sc-subtotal-amount-buybox .a-offscreen",
  quantity: "select[name='quantity']",
  quantityField: "input[name='quantityBox'], input.sc-quantity-textfield",
  quantityPrompt: ".a-dropdown-prompt",
  proceedToCheckout: 'input[name="proceedToRetailCheckout"]',
  buyBox: "#sc-buy-box #sc-buy-box-ptc-button .a-button-input",
  ptcButton: "#sc-buy-box-ptc-button",
  buyNow: "#buy-now-button, input[name='submit.buy-now']",
  placeYourOrder1: 'input[name="placeYourOrder1"]',
  placeOrder: "#placeOrder, #submitOrderButtonId input",
  bottomSubmit: "#bottomSubmitOrderButtonId input",
  placeYourOrder: "#placeYourOrder",
  turboCheckout: "#turbo-checkout-pyo-button",
  confirmationStatus: "#widget-purchaseConfirmationStatus",
  confirmationCopy:
    "#widget-purchaseConfirmationStatus, #widget-purchaseConfirmationDetails, #ty-thankyou, #purchase-confirmation, [id*='purchaseConfirmation'], [id*='purchase-confirmation'], [class*='purchase-confirmation'], [id*='thankyou'], [id*='thank-you']",
} as const;

/** Bag-area nodes the shared watcher can observe. Header and footer stay outside. */
export const AMAZON_BAG_ITEM = AMAZON_SELECTORS.lineItem;
export const AMAZON_BAG_TOTAL = AMAZON_SELECTORS.subtotal;

const CHECKOUT_SELECTORS = [
  AMAZON_SELECTORS.proceedToCheckout,
  AMAZON_SELECTORS.buyBox,
  AMAZON_SELECTORS.ptcButton,
  AMAZON_SELECTORS.buyNow,
  AMAZON_SELECTORS.placeYourOrder1,
  AMAZON_SELECTORS.placeOrder,
  AMAZON_SELECTORS.bottomSubmit,
  AMAZON_SELECTORS.placeYourOrder,
  AMAZON_SELECTORS.turboCheckout,
] as const;

const CHECKOUT_LABEL = /^(proceed to checkout|buy now)$/i;

/** Same chrome the Apple adapter refuses to dim. */
const SITE_CHROME = "nav, header, footer, [role='banner'], [role='contentinfo']";

export const amazonAdapter: StoreAdapter = {
  id: "amazon",
  match(loc) {
    if (isLocalAmazonFixture(loc.href)) {
      return true;
    }
    if (!isAmazonHost(loc.hostname)) {
      return false;
    }
    const path = loc.pathname;
    return isCartPath(path) || isCheckoutPath(path) || isThankYouPath(path);
  },
  readBag(doc) {
    const root = doc.querySelector(AMAZON_SELECTORS.cart) ?? doc;
    const items: BagItem[] = [];
    for (const row of root.querySelectorAll(AMAZON_SELECTORS.lineItem)) {
      const item = lineTitle(row);
      const unitCents = parseAmazonCents(linePriceText(row));
      if (!item || unitCents === null) {
        return null;
      }
      const quantity = quantityFrom(row);
      const price = unitCents * quantity;
      if (!Number.isSafeInteger(price)) {
        return null;
      }
      items.push({ item, price, category: categoryForItem(item), quantity });
    }
    if (items.length === 0) {
      return null;
    }
    const subtotalText = doc.querySelector(AMAZON_SELECTORS.subtotal)?.textContent ?? "";
    const parsedTotal = parseAmazonCents(subtotalText);
    const total = parsedTotal ?? items.reduce((sum, row) => sum + row.price, 0);
    if (!Number.isSafeInteger(total) || total <= 0) {
      return null;
    }
    const bag: Bag = { items, total, quantity: items[0]?.quantity ?? 1 };
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
    for (const selector of CHECKOUT_SELECTORS) {
      for (const node of doc.querySelectorAll(selector)) {
        add(node);
      }
    }
    for (const node of doc.querySelectorAll("button, a, input, [role='button']")) {
      if (isCheckoutLabel(node)) {
        add(node);
      }
    }
    return [...seen];
  },
  isOrderConfirmation(doc) {
    const loc = doc.defaultView?.location;
    if (loc && isAmazonHost(loc.hostname) && isThankYouPath(loc.pathname)) {
      return true;
    }
    if (doc.querySelector(AMAZON_SELECTORS.confirmationStatus)) {
      return true;
    }
    for (const node of doc.querySelectorAll(AMAZON_SELECTORS.confirmationCopy)) {
      if ((node.textContent ?? "").toLowerCase().includes("order has been placed")) {
        return true;
      }
    }
    return false;
  },
};

/**
 * Full title once. `.sc-product-title` also contains the truncated copy and a
 * screen-reader span, so textContent repeats the name and can end with
 * "Opens in a new tab."
 */
function lineTitle(row: Element): string {
  const title = row.querySelector(AMAZON_SELECTORS.title);
  if (!title) {
    return "";
  }
  const full = title.classList.contains("a-truncate-full") ? title : title.querySelector(".a-truncate-full");
  return normalizeItemName(elementText(full ?? title));
}

function elementText(node: Element): string {
  const view = node.ownerDocument.defaultView;
  const ElementCtor = view?.Element;
  const copy = node.cloneNode(true);
  if (!ElementCtor || !(copy instanceof ElementCtor)) {
    return node.textContent ?? "";
  }
  for (const hidden of copy.querySelectorAll(".a-offscreen, [hidden]")) {
    hidden.remove();
  }
  return copy.textContent ?? "";
}

/** Reads a currency string such as "$179.00" into integer cents (17900). */
export function parseAmazonCents(text: string): number | null {
  const match = text.replace(/\u00a0/g, " ").match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match?.[0]) {
    return null;
  }
  const dollars = Number(match[0].replace(/,/g, ""));
  if (!Number.isFinite(dollars)) {
    return null;
  }
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents)) {
    return null;
  }
  return cents;
}

function linePriceText(row: Element): string {
  const current = row.querySelector(AMAZON_SELECTORS.price)?.textContent ?? "";
  if (parseAmazonCents(current) !== null) {
    return current;
  }
  for (const node of row.querySelectorAll(AMAZON_SELECTORS.legacyPrice)) {
    if (node.closest("[data-a-strike]")) {
      continue;
    }
    const text = node.textContent ?? "";
    if (parseAmazonCents(text) !== null) {
      return text;
    }
  }
  return "";
}

/**
 * Selected quantity on the line. A visible dropdown wins, hidden controls are
 * ignored, and a missing control is one unit.
 */
function quantityFrom(row: Element): number {
  const view = row.ownerDocument.defaultView;
  const Select = view?.HTMLSelectElement;
  if (Select) {
    for (const node of row.querySelectorAll(AMAZON_SELECTORS.quantity)) {
      if (!(node instanceof Select) || node.getAttribute("aria-hidden") === "true" || node.hidden) {
        continue;
      }
      const selected = positiveQuantity(node.value);
      if (selected !== null) {
        return selected;
      }
    }
  }
  const Input = view?.HTMLInputElement;
  const field = row.querySelector(AMAZON_SELECTORS.quantityField);
  if (Input && field instanceof Input) {
    const typed = positiveQuantity(field.value);
    if (typed !== null) {
      return typed;
    }
  }
  const fromData = positiveQuantity(row.getAttribute("data-quantity") ?? "");
  if (fromData !== null) {
    return fromData;
  }
  const prompt = row.querySelector(AMAZON_SELECTORS.quantityPrompt)?.textContent ?? "";
  return positiveQuantity(prompt.replace(/^qty\s*:?\s*/i, "")) ?? 1;
}

function positiveQuantity(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const quantity = Number(text);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return null;
  }
  return quantity;
}

function isCheckoutLabel(node: Element): boolean {
  const value = (node.getAttribute("value") ?? "").replace(/\s+/g, " ").trim();
  const aria = (node.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
  if (CHECKOUT_LABEL.test(value) || CHECKOUT_LABEL.test(aria)) {
    return true;
  }
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length <= 40 && CHECKOUT_LABEL.test(text);
}

function isAmazonHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "amazon.com" || host.endsWith(".amazon.com");
}

function isCartPath(path: string): boolean {
  return /\/gp\/cart(?:\/|$)/i.test(path) || /\/cart(?:\/|$)/i.test(path);
}

function isCheckoutPath(path: string): boolean {
  return /\/checkout(?:\/|$)/i.test(path) || /\/gp\/buy(?:\/|$)/i.test(path);
}

function isThankYouPath(path: string): boolean {
  return /\/gp\/buy\/thankyou(?:\/|$)/i.test(path);
}

function categoryForItem(name: string): string {
  const text = name.toLowerCase();
  if (/\b(cable|charger|adapter)\b/.test(text)) {
    return "cable";
  }
  if (/\b(case|cover)\b/.test(text)) {
    return "case";
  }
  if (/\b(headphones|earbuds)\b/.test(text)) {
    return "audio";
  }
  if (/\bwatch\b/.test(text)) {
    return "watch";
  }
  if (/\b(ipad|tablet)\b/.test(text)) {
    return "tablet";
  }
  if (/\b(macbook|laptop)\b/.test(text)) {
    return "computer";
  }
  if (/\b(phone|iphone)\b/.test(text)) {
    return "phone";
  }
  return "other";
}
