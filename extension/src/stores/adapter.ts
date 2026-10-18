export interface BagItem {
  item: string;
  price: number;
  category: string;
}

export interface Bag {
  items: BagItem[];
  total: number;
}

export interface StoreAdapter {
  id: "apple" | "amazon" | string;
  match(loc: Location): boolean;
  /** Null when the bag cannot be read. Prices are cents. */
  readBag(doc: Document): Bag | null;
  /** Checkout controls to dim. Must not include nav, header, or footer. */
  checkoutButtons(doc: Document): HTMLElement[];
  /** True on an order confirmation page. */
  isOrderConfirmation(doc: Document): boolean;
}
