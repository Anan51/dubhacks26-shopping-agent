import { isAppleCardCheckout, isApplePayControl, isBlockedControl, isCheckOutControl, readableBag, type BagControl } from "../../../src/apple-bag.js";
import { applePage } from "../../../src/sites.js";
import { readPageBag } from "../bag-dom.js";
import type { Bag, StoreAdapter } from "./adapter.js";

const CANDIDATES = "button, a, input, apple-pay-button, [role='button']";
const SITE_CHROME =
  "footer, nav, header, #globalheader, #globalfooter, #ac-globalfooter, #ac-globalheader, #globalnav, #ac-globalnav, .globalheader, .globalfooter, [role='banner'], [role='contentinfo']";

export const appleAdapter: StoreAdapter = {
  id: "apple",
  match(loc) {
    return applePage(loc.href) !== null;
  },
  readBag(doc) {
    if (!doc.body) {
      return null;
    }
    const page = readPageBag(doc.body);
    const ready = readableBag(page);
    if (!ready) {
      return null;
    }
    return {
      items: ready.itemNames.map((name) => ({ item: name, price: ready.totalCents, category: "apple" })),
      total: ready.totalCents,
    };
  },
  checkoutButtons(doc) {
    const href = doc.defaultView?.location.href ?? "";
    const kind = applePage(href) ?? "bag";
    return [...doc.querySelectorAll(CANDIDATES)].flatMap((node) => {
      if (!isHtmlElement(node) || node.closest(SITE_CHROME)) {
        return [];
      }
      const control = controlFrom(node);
      if (!isBlockedControl(control, kind) && !isApplePayControl(control) && !isCheckOutControl(control) && !isAppleCardCheckout(control)) {
        return [];
      }
      if (!isBlockedControl(control, kind)) {
        return [];
      }
      return [node];
    });
  },
  isOrderConfirmation() {
    return false;
  },
};

function isHtmlElement(node: Element): node is HTMLElement {
  if (typeof HTMLElement === "undefined") {
    return true;
  }
  return node instanceof HTMLElement;
}

function controlFrom(node: Element): BagControl {
  return {
    tag: node.tagName.toLowerCase(),
    text: node.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
    ariaLabel: node.getAttribute("aria-label") ?? "",
  };
}

export function bagItems(bag: Bag): { names: string[]; totalCents: number } {
  return {
    names: bag.items.map((item) => item.item).filter((name) => name.length > 0),
    totalCents: bag.total,
  };
}
