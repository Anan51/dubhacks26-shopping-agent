import type { CartItem, CatalogKind } from "./types.js";

export type CatalogProduct = CartItem & {
  blurb: string;
};

/** Fictional devices and plans. No carrier logos, no real product names. */
export const CATALOG: readonly CatalogProduct[] = [
  {
    id: "phone-n1-128",
    kind: "phone",
    name: "Northstar N1",
    detail: "128 GB",
    blurb: "Last year's slab. Still quick, camera is ordinary.",
    priceCents: 79_900,
    cadence: "once",
  },
  {
    id: "phone-n1-256",
    kind: "phone",
    name: "Northstar N1",
    detail: "256 GB",
    blurb: "Same phone, more room for photos.",
    priceCents: 89_900,
    cadence: "once",
  },
  {
    id: "phone-harbor-fold",
    kind: "phone",
    name: "Harbor Fold",
    detail: "256 GB",
    blurb: "A hinge and a higher price. Easy to talk yourself into.",
    priceCents: 119_900,
    cadence: "once",
  },
  {
    id: "phone-lumen-mini",
    kind: "phone",
    name: "Lumen Mini",
    detail: "128 GB",
    blurb: "Smaller, cheaper, two-day battery in the brochure.",
    priceCents: 44_900,
    cadence: "once",
  },
  {
    id: "plan-unlimited",
    kind: "plan",
    name: "Signal Unlimited",
    detail: "Unlimited talk and data",
    blurb: "The default line. Price is per month.",
    priceCents: 7_000,
    cadence: "monthly",
  },
  {
    id: "plan-plus",
    kind: "plan",
    name: "Signal Plus",
    detail: "Unlimited + hotspot",
    blurb: "Adds a hotspot bucket. Still a monthly bill.",
    priceCents: 9_000,
    cadence: "monthly",
  },
  {
    id: "plan-prepaid",
    kind: "plan",
    name: "Signal Prepaid",
    detail: "15 GB",
    blurb: "A smaller bill if you can live inside the cap.",
    priceCents: 4_000,
    cadence: "monthly",
  },
  {
    id: "acc-case",
    kind: "accessory",
    name: "Clear shell case",
    detail: "One piece",
    blurb: "Cheap insurance. Does not make the phone newer.",
    priceCents: 2_900,
    cadence: "once",
  },
  {
    id: "acc-film",
    kind: "accessory",
    name: "Ceramic screen film",
    detail: "Two-pack",
    blurb: "For the phone you already have, too.",
    priceCents: 1_900,
    cadence: "once",
  },
  {
    id: "acc-charger",
    kind: "accessory",
    name: "20W puck charger",
    detail: "USB-C",
    blurb: "A charger is not an upgrade.",
    priceCents: 2_500,
    cadence: "once",
  },
  {
    id: "acc-cable",
    kind: "accessory",
    name: "USB-C cable",
    detail: "1 m",
    blurb: "Braided. Still just a cable.",
    priceCents: 1_200,
    cadence: "once",
  },
];

export const DEFAULT_ITEM_IDS = ["phone-n1-128", "plan-unlimited", "acc-case"] as const;

export function productById(id: string): CatalogProduct | undefined {
  return CATALOG.find((product) => product.id === id);
}

export function productsByKind(kind: CatalogKind): CatalogProduct[] {
  return CATALOG.filter((product) => product.kind === kind);
}

export function itemsForIds(ids: readonly string[]): CartItem[] | undefined {
  const items: CartItem[] = [];
  for (const id of ids) {
    const product = productById(id);
    if (!product) {
      return undefined;
    }
    items.push({
      id: product.id,
      kind: product.kind,
      name: product.name,
      detail: product.detail,
      priceCents: product.priceCents,
      cadence: product.cadence,
    });
  }
  return items;
}
