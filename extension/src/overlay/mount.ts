import type { OverlayActions, OverlayModel } from "../overlay.js";
import { mountOverlay } from "../overlay.js";
import type { StoreAdapter } from "../stores/adapter.js";

/** Shadow-root card. Host page CSS cannot reach the overlay. */
export function mountSimmerCard(
  adapter: StoreAdapter,
  doc: Document,
  css: string,
  model: OverlayModel,
  actions: OverlayActions,
): { update: (next: OverlayModel) => void; unmount: () => void } {
  const host = doc.createElement("div");
  host.id = "simmer-root";
  host.setAttribute("data-simmer-store", adapter.id);
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = css;
  shadow.append(style);
  const update = mountOverlay(shadow, model, actions);
  (doc.documentElement ?? doc.body ?? doc).append(host);
  return {
    update,
    unmount: () => host.remove(),
  };
}
