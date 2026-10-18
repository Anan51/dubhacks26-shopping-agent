import { isApplePayControl, isCheckOutControl } from "../../src/apple-bag.js";
import { BLOCKED_STYLE_ID, PAY_CONTROLS } from "./gate.js";

export type PageWatch = {
  disconnect: () => void;
  /** Run a DOM write without letting it schedule another pass. */
  mute: (write: () => void) => void;
};

/**
 * True when a mutation came from Simmer's overlay, block style, badge, or block attributes.
 * Apple's own bag text is not ours.
 */
export function mutationIsOurs(record: MutationRecord): boolean {
  if (record.type === "attributes") {
    const name = record.attributeName ?? "";
    if (name.startsWith("data-simmer-")) {
      return true;
    }
    const target = record.target;
    if (
      isElementNode(target) &&
      target.hasAttribute("data-simmer-blocked") &&
      (name === "aria-disabled" || name === "disabled")
    ) {
      return true;
    }
    return isSimmerNode(record.target);
  }
  if (record.type === "characterData") {
    return isSimmerNode(record.target);
  }
  if (record.type === "childList") {
    if (isSimmerNode(record.target)) {
      return true;
    }
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every((node) => isSimmerNode(node));
  }
  return false;
}

/**
 * Document observer for the bag page.
 * Simmer's own records are ignored. Any other burst becomes one animation frame, or one microtask when the page has no frame callback.
 */
export function watchPage(doc: Document, onForeign: () => void): PageWatch {
  const view = doc.defaultView ?? globalThis;
  let observer: MutationObserver | null = null;
  let frame = 0;
  let queued = false;
  let alive = true;
  let muted = 0;

  const schedule = () => {
    if (!alive || queued) {
      return;
    }
    queued = true;
    const flush = () => {
      queued = false;
      frame = 0;
      if (!alive) {
        return;
      }
      if (muted > 0) {
        schedule();
        return;
      }
      onForeign();
    };
    const raf = view.requestAnimationFrame;
    if (typeof raf === "function") {
      frame = raf.call(view, flush);
      return;
    }
    queueMicrotask(flush);
  };

  const connect = () => {
    if (!doc.documentElement) {
      return;
    }
    observer?.disconnect();
    const ObserverCtor = view.MutationObserver ?? globalThis.MutationObserver;
    observer = new ObserverCtor((records) => {
      if (muted > 0 || !recordsNeedGate(records)) {
        return;
      }
      schedule();
    });
    // childList only. characterData on apple.com never stops (hydration, live regions,
    // analytics) and was repainting the gate on every one of those edits.
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  };

  connect();

  return {
    disconnect: () => {
      alive = false;
      queued = false;
      if (frame !== 0 && typeof view.cancelAnimationFrame === "function") {
        view.cancelAnimationFrame(frame);
      }
      frame = 0;
      observer?.disconnect();
      observer = null;
    },
    mute: (write) => {
      // Stay connected. Disconnecting and re-observing documentElement makes Chrome
      // walk Apple's whole tree, and a locked bag was doing that on every edit.
      muted += 1;
      try {
        write();
      } finally {
        // Pull the queued records so our own childList edits cannot schedule another pass.
        // A pay control the page adds in this same turn is gated here, not on the next refresh.
        const pending = observer?.takeRecords() ?? [];
        muted -= 1;
        if (!alive) {
          return;
        }
        const foreign = pending.filter((record) => !mutationIsOurs(record));
        if (foreign.some(recordAddsPayControl)) {
          onForeign();
          return;
        }
        if (recordsNeedGate(foreign)) {
          schedule();
        }
      }
    },
  };
}

function recordsNeedGate(records: MutationRecord[]): boolean {
  if (records.every(mutationIsOurs)) {
    return false;
  }
  return records.some(recordTouchesPay);
}

function recordAddsPayControl(record: MutationRecord): boolean {
  if (record.type !== "childList") {
    return false;
  }
  return [...record.addedNodes].some(nodeContainsPayControl);
}

function nodeContainsPayControl(node: Node): boolean {
  if (!isElementNode(node)) {
    return false;
  }
  if (node.matches(PAY_CONTROLS) && elementIsPayControl(node)) {
    return true;
  }
  return [...node.querySelectorAll(PAY_CONTROLS)].some(elementIsPayControl);
}

function elementIsPayControl(node: Element): boolean {
  const text = collapsedLabel(node.textContent ?? "").slice(0, 80);
  const aria = collapsedLabel(node.getAttribute("aria-label") ?? "");
  const value = collapsedLabel(node.getAttribute("value") ?? "");
  const control = {
    tag: node.tagName.toLowerCase(),
    text: text || value,
    ariaLabel: aria,
  };
  if (isCheckOutControl(control) || isApplePayControl(control)) {
    return true;
  }
  return [text, aria, value].some(isProceedOrBuyNowLabel);
}

function collapsedLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isProceedOrBuyNowLabel(value: string): boolean {
  return value === "proceed" || value === "proceed to checkout" || value === "buy now";
}

function recordTouchesPay(record: MutationRecord): boolean {
  if (mutationIsOurs(record) || record.type !== "childList") {
    return false;
  }
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.some(nodeTouchesPay);
}

function nodeTouchesPay(node: Node): boolean {
  if (!isElementNode(node)) {
    return false;
  }
  if (node.matches(PAY_CONTROLS) || node.hasAttribute("data-simmer-blocked") || node.id === BLOCKED_STYLE_ID) {
    return true;
  }
  return node.querySelector(`${PAY_CONTROLS}, [data-simmer-blocked], #${BLOCKED_STYLE_ID}`) !== null;
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

function isSimmerNode(node: Node | null): boolean {
  if (!node) {
    return false;
  }
  if (node.nodeType === 3 || node.nodeType === 8) {
    return isSimmerNode(node.parentNode);
  }
  if (!isElementNode(node)) {
    return false;
  }
  if (node.id === "simmer-root" || node.id === BLOCKED_STYLE_ID) {
    return true;
  }
  if (node.hasAttribute("data-simmer-badge") || node.hasAttribute("data-simmer-store")) {
    return true;
  }
  return node.closest(`#simmer-root, #${BLOCKED_STYLE_ID}, [data-simmer-badge]`) !== null;
}
