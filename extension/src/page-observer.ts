import { BLOCKED_STYLE_ID } from "./gate.js";

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
      if (muted > 0 || records.every(mutationIsOurs)) {
        return;
      }
      schedule();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
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
      muted += 1;
      observer?.disconnect();
      try {
        write();
      } finally {
        muted -= 1;
        if (muted === 0 && doc.documentElement) {
          connect();
        }
      }
    },
  };
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
