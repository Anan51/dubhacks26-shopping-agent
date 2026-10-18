import type { StoreAdapter } from "../stores/adapter.js";

const CHROME =
  "footer, nav, header, #globalheader, #globalfooter, #ac-globalfooter, #ac-globalheader, #globalnav, #ac-globalnav, .globalheader, .globalfooter, [role='banner'], [role='contentinfo']";

/** Checkout buttons from the adapter, minus anything sitting in site chrome. */
export function buttonsToBlock(adapter: StoreAdapter, doc: Document): HTMLElement[] {
  return adapter.checkoutButtons(doc).filter((element) => !element.closest(CHROME));
}
