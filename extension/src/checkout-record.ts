export type CheckoutSnapshot = {
  code: string;
  unlocked: boolean;
};

/** Records one purchase per bag when an unlocked checkout control is clicked. */
export function bindCheckoutClicks(
  doc: Document,
  buttons: () => readonly HTMLElement[],
  state: () => CheckoutSnapshot,
  record: (code: string) => Promise<void> | void,
): () => void {
  let pending = false;
  const recorded = new Set<string>();
  const onClick = (event: Event) => {
    const bag = state();
    if (!bag.unlocked || bag.code.length === 0 || pending || recorded.has(bag.code)) {
      return;
    }
    const target = eventTargetNode(event.target);
    if (!target) {
      return;
    }
    const hit = buttons().some((button) => button === target || button.contains(target));
    if (!hit) {
      return;
    }
    const code = bag.code;
    pending = true;
    void Promise.resolve(record(code))
      .then(() => {
        recorded.add(code);
      })
      .catch(() => undefined)
      .finally(() => {
        pending = false;
      });
  };
  doc.addEventListener("click", onClick, true);
  return () => {
    doc.removeEventListener("click", onClick, true);
  };
}

function eventTargetNode(target: EventTarget | null): Node | null {
  if (typeof target !== "object" || target === null || !("nodeType" in target)) {
    return null;
  }
  const nodeType = target.nodeType;
  if (typeof nodeType !== "number") {
    return null;
  }
  return target as Node;
}
