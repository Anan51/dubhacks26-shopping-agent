import { readPageBag, type BagLineItem, type PageBag } from "./bag-dom.js";
import type { Bag, StoreAdapter } from "./stores/adapter.js";

/**
 * Apple keeps the page reader (quantity lives on the dropdown).
 * Any other adapter fills the same page-bag shape from `readBag`.
 */
export function readActiveBag(site: StoreAdapter, doc: Document): PageBag {
  if (site.id !== "apple") {
    const fromStore = pageBagFromStore(site.readBag(doc));
    if (fromStore) {
      return fromStore;
    }
  }
  if (!doc.body) {
    return emptyPageBag();
  }
  return readPageBag(doc.body);
}

export function pageBagFromStore(bag: Bag | null): PageBag | null {
  if (!bag || !Number.isInteger(bag.total) || bag.total <= 0) {
    return null;
  }
  const items: BagLineItem[] = [];
  for (const [index, row] of bag.items.entries()) {
    const name = row.item.trim();
    if (!name || !Number.isInteger(row.price)) {
      return null;
    }
    const quantity = row.quantity ?? (index === 0 ? bag.quantity ?? null : null);
    items.push({
      position: index + 1,
      name,
      quantity: quantity ?? null,
      linePriceCents: row.price,
    });
  }
  if (items.length === 0) {
    return null;
  }
  return {
    items,
    itemNames: items.map((item) => item.name),
    quantity: items[0]?.quantity ?? bag.quantity ?? null,
    subtotalCents: bag.total,
    totalCents: bag.total,
    parsed: true,
  };
}

function emptyPageBag(): PageBag {
  return {
    items: [],
    itemNames: [],
    quantity: null,
    subtotalCents: null,
    totalCents: null,
    parsed: false,
  };
}
