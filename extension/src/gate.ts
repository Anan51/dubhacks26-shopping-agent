import { isBlockedControl, type BagControl } from "../../src/apple-bag.js";
import type { ApplePage } from "../../src/sites.js";

export const BLOCKED_STYLE_ID = "simmer-blocked-style";

/** Attribute-scoped so the rest of apple.com is left alone. */
export const BLOCKED_BUTTON_CSS = `
[data-simmer-blocked] {
  opacity: 0.45 !important;
  filter: grayscale(1) !important;
  cursor: not-allowed !important;
  pointer-events: none !important;
}
[data-simmer-blocked]::after {
  content: "Marinating";
  display: inline-block;
  margin-left: 0.45rem;
  font-size: 0.75rem;
  line-height: 1;
  letter-spacing: 0.01em;
  color: #6b5438;
  white-space: nowrap;
  pointer-events: none;
}
`;

const CANDIDATES = "button, a, input, apple-pay-button, [role='button']";

export type Gate = {
  paint: () => void;
  lift: () => void;
  stop: () => void;
};

export function installGate(doc: Document, kind: ApplePage): Gate {
  // Lift only clears the block. It must never click, submit, or complete Apple's button.
  let blocked = true;
  const view = doc.defaultView;
  const stopEvent = (event: Event) => {
    if (!blocked) {
      return;
    }
    const control = controlFrom(event.target);
    if (!control || !isBlockedControl(control, kind)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const stopSubmit = (event: Event) => {
    if (!blocked || event.type !== "submit") {
      return;
    }
    const submitter = "submitter" in event ? (event as SubmitEvent).submitter : null;
    const control = controlFrom(submitter);
    if (!control || !isBlockedControl(control, kind)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  view?.addEventListener("click", stopEvent, true);
  view?.addEventListener("pointerdown", stopEvent, true);
  view?.addEventListener("submit", stopSubmit, true);
  const paint = () => {
    if (blocked) {
      ensureBlockedStyle(doc);
    }
    paintBlockedControls(doc, kind, blocked);
    if (!blocked) {
      removeBlockedStyle(doc);
    }
  };
  return {
    paint,
    lift: () => {
      blocked = false;
      paint();
    },
    stop: () => {
      blocked = false;
      view?.removeEventListener("click", stopEvent, true);
      view?.removeEventListener("pointerdown", stopEvent, true);
      view?.removeEventListener("submit", stopSubmit, true);
      paint();
    },
  };
}

export function ensureBlockedStyle(doc: Document): void {
  if (doc.getElementById(BLOCKED_STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = BLOCKED_STYLE_ID;
  style.textContent = BLOCKED_BUTTON_CSS;
  (doc.head ?? doc.documentElement).append(style);
}

export function removeBlockedStyle(doc: Document): void {
  doc.getElementById(BLOCKED_STYLE_ID)?.remove();
}

/** Mark checkout controls, or put back exactly the ones this gate changed. */
export function paintBlockedControls(doc: Document, kind: ApplePage, blocked: boolean): void {
  if (!doc.body) {
    return;
  }
  if (!blocked) {
    for (const node of doc.querySelectorAll("[data-simmer-blocked]")) {
      restoreControl(node);
    }
    return;
  }
  for (const node of doc.querySelectorAll(CANDIDATES)) {
    const control = controlFrom(node);
    const mark = control !== null && isBlockedControl(control, kind);
    if (mark) {
      node.setAttribute("data-simmer-blocked", "1");
      node.setAttribute("aria-disabled", "true");
      disableIfOurs(node);
    } else if (node.hasAttribute("data-simmer-blocked")) {
      restoreControl(node);
    }
  }
}

function isDisableable(node: Element): node is HTMLButtonElement | HTMLInputElement {
  return node.tagName === "BUTTON" || node.tagName === "INPUT";
}

function disableIfOurs(node: Element): void {
  if (!isDisableable(node)) {
    return;
  }
  if (node.getAttribute("data-simmer-disabled") === "1") {
    node.disabled = true;
    return;
  }
  if (node.disabled) {
    return;
  }
  node.disabled = true;
  node.setAttribute("data-simmer-disabled", "1");
}

function restoreControl(node: Element): void {
  if (node.getAttribute("data-simmer-disabled") === "1") {
    if (isDisableable(node)) {
      node.disabled = false;
    }
    node.removeAttribute("data-simmer-disabled");
  }
  node.removeAttribute("data-simmer-blocked");
  node.removeAttribute("aria-disabled");
}

function controlFrom(target: EventTarget | null): BagControl | null {
  const element = isElementTarget(target) ? target : null;
  const control = element?.closest(CANDIDATES);
  if (!control) {
    return null;
  }
  return {
    tag: control.tagName.toLowerCase(),
    text: control.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
    ariaLabel: control.getAttribute("aria-label") ?? "",
  };
}

function isElementTarget(target: EventTarget | null): target is Element {
  return typeof target === "object" && target !== null && "nodeType" in target && (target as Node).nodeType === 1;
}
