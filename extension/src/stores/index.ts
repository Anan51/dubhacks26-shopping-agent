import { amazonAdapter } from "./amazon.js";
import { appleAdapter } from "./apple.js";
import type { StoreAdapter } from "./adapter.js";

/** Add a store by appending one adapter. Manifest host matches stay next to this list. */
export const adapters: readonly StoreAdapter[] = [appleAdapter, amazonAdapter];

export function adapterFor(loc: Location): StoreAdapter | null {
  return adapters.find((adapter) => adapter.match(loc)) ?? null;
}
