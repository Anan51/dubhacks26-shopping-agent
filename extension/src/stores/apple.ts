import { readableBag } from "../../../src/apple-bag.js";
import { applePage } from "../../../src/sites.js";
import { readPageBag } from "../bag-dom.js";
import { collectPayControls } from "../gate.js";
import type { Bag, StoreAdapter } from "./adapter.js";

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
    return collectPayControls(doc, kind);
  },
  isOrderConfirmation() {
    return false;
  },
};

export function bagItems(bag: Bag): { names: string[]; totalCents: number } {
  return {
    names: bag.items.map((item) => item.item).filter((name) => name.length > 0),
    totalCents: bag.total,
  };
}
