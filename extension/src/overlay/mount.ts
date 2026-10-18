import type { OverlayActions, OverlayModel } from "../overlay.js";
import { mountOverlay } from "../overlay.js";
import type { StoreAdapter } from "../stores/adapter.js";

/**
 * The panel's z-index lives in the shadow tree and does not raise the host.
 * Apple's footer and the fixed checkout bar (z-index 1000000) then sit on top of Unlock.
 * Pin the host itself above that bar.
 */
export function pinSimmerHost(host: HTMLElement): void {
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("top", "0", "important");
  host.style.setProperty("left", "0", "important");
  host.style.setProperty("width", "0", "important");
  host.style.setProperty("height", "0", "important");
  host.style.setProperty("margin", "0", "important");
  host.style.setProperty("overflow", "visible", "important");
  host.style.setProperty("pointer-events", "none", "important");
  host.style.setProperty("z-index", "2147483647", "important");
}

/** Shadow-root card. Host page CSS cannot reach the overlay. The host is put back if the page removes it. */
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
  pinSimmerHost(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = css;
  shadow.append(style);
  const update = mountOverlay(shadow, model, actions);
  const release = holdSimmerHost(doc, host);
  return {
    update,
    unmount: () => {
      release();
      host.remove();
    },
  };
}

function holdSimmerHost(doc: Document, host: HTMLElement): () => void {
  let live = true;
  const view = doc.defaultView ?? globalThis;
  const ObserverCtor = view.MutationObserver ?? globalThis.MutationObserver;
  const place = () => {
    const parent = doc.documentElement ?? doc.body;
    if (!parent) {
      return;
    }
    pinSimmerHost(host);
    if (!host.isConnected) {
      parent.append(host);
    }
  };
  const observer = new ObserverCtor(() => {
    if (!live || host.isConnected) {
      return;
    }
    place();
  });
  place();
  if (doc.documentElement) {
    observer.observe(doc.documentElement, { childList: true });
  }
  observer.observe(doc, { childList: true });
  return () => {
    live = false;
    observer.disconnect();
  };
}
