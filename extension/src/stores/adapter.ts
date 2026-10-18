export interface BagItem {
  item: string;
  /** Line total in integer cents (unit price times quantity). */
  price: number;
  category: string;
  /** Units on this line, when the store shows one. */
  quantity?: number;
}

export interface Bag {
  items: BagItem[];
  /** Bag total in integer cents. */
  total: number;
  /** Units of the first line. The card sums every line's quantity. */
  quantity?: number;
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
