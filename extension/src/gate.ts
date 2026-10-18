import { isBlockedControl, type BagControl } from "../../src/apple-bag.js";
import type { ApplePage } from "../../src/sites.js";

export const BLOCKED_STYLE_ID = "simmer-blocked-style";

/** Attribute-scoped so the rest of apple.com is left alone. The label is a sibling, so the dimming does not gray it out. */
export const BLOCKED_BUTTON_CSS = `
[data-simmer-blocked] {
  opacity: 0.45 !important;
  filter: grayscale(1) !important;
  cursor: not-allowed !important;
  pointer-events: none !important;
}
[data-simmer-badge] {
  display: inline-block !important;
  margin-left: 0.45rem !important;
  padding: 0.2rem 0.5rem !important;
  border-radius: 999px !important;
  background: #1c1c1e !important;
  color: #fff !important;
  font: 600 0.75rem/1 system-ui, sans-serif !important;
  letter-spacing: 0.01em !important;
  white-space: nowrap !important;
  vertical-align: middle !important;
  opacity: 1 !important;
  filter: none !important;
  pointer-events: none !important;
}
`;

/**
 * Checkout and express-pay controls only.
 * A catch-all of `a` or `[role=button]` also matches nav, footers, and the
 * page shell Apple wraps around the bag. Those containers then swallow every click.
 */
export const PAY_CONTROLS =
  "button, input[type='submit'], input[type='button'], input[type='image'], apple-pay-button, [data-autom='checkout'], [data-autom='checkout-with-apple-pay']";

const NESTED_INTERACTIVE = "a, button, input, select, textarea, apple-pay-button, [role='button']";

export type Gate = {
  paint: () => void;
  lift: () => void;
  stop: () => void;
};

export function installGate(doc: Document, scope: ApplePage | (() => readonly Element[])): Gate {
  const listed = typeof scope === "function" ? scope : null;
  const kind: ApplePage | null = typeof scope === "function" ? null : scope;
  const targeted = (node: Element) => {
    if (listed) {
      return scopeBlockedControls(listed()).some((button) => button === node || button.contains(node));
    }
    return kind !== null && shouldBlock(node, kind);
  };
  // Lift only clears the block. It must never click, submit, or complete Apple's button.
  let blocked = true;
  const view = doc.defaultView;
  const stopEvent = (event: Event) => {
    if (!blocked) {
      return;
    }
    const control = controlElement(event.target);
    if (!control || !targeted(control)) {
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
    const control = controlElement(submitter);
    if (!control || !targeted(control)) {
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
    if (listed) {
      paintListed(doc, listed(), blocked);
    } else if (kind) {
      paintBlockedControls(doc, kind, blocked);
    }
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

function paintListed(doc: Document, buttons: readonly Element[], blocked: boolean): void {
  if (!doc.body) {
    return;
  }
  if (!blocked) {
    for (const node of doc.querySelectorAll("[data-simmer-blocked]")) {
      restoreControl(node);
    }
    for (const badge of doc.querySelectorAll("[data-simmer-badge]")) {
      badge.remove();
    }
    return;
  }
  const chosen = new Set(scopeBlockedControls(buttons));
  for (const node of doc.querySelectorAll("[data-simmer-blocked]")) {
    if (!chosen.has(node)) {
      restoreControl(node);
    }
  }
  for (const node of chosen) {
    markBlocked(node);
  }
  for (const badge of doc.querySelectorAll("[data-simmer-badge]")) {
    const previous = badge.previousElementSibling;
    if (!previous?.hasAttribute("data-simmer-blocked")) {
      badge.remove();
    }
  }
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
    for (const badge of doc.querySelectorAll("[data-simmer-badge]")) {
      badge.remove();
    }
    return;
  }
  const chosen = new Set<Element>(collectPayControls(doc, kind));
  for (const node of doc.querySelectorAll("[data-simmer-blocked]")) {
    if (!chosen.has(node)) {
      restoreControl(node);
    }
  }
  for (const node of chosen) {
    markBlocked(node);
  }
  for (const badge of doc.querySelectorAll("[data-simmer-badge]")) {
    const previous = badge.previousElementSibling;
    if (!previous?.hasAttribute("data-simmer-blocked")) {
      badge.remove();
    }
  }
}

function isDisableable(node: Element): node is HTMLButtonElement | HTMLInputElement {
  return node.tagName === "BUTTON" || node.tagName === "INPUT";
}

function markBlocked(node: Element): void {
  setAttrIfChanged(node, "data-simmer-blocked", "1");
  setAttrIfChanged(node, "aria-disabled", "true");
  disableIfOurs(node);
  ensureBadge(node);
}

function setAttrIfChanged(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

function disableIfOurs(node: Element): void {
  if (!isDisableable(node)) {
    return;
  }
  if (node.getAttribute("data-simmer-disabled") === "1") {
    if (!node.disabled) {
      node.disabled = true;
    }
    return;
  }
  if (node.disabled) {
    return;
  }
  node.disabled = true;
  setAttrIfChanged(node, "data-simmer-disabled", "1");
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
  const badge = node.nextElementSibling;
  if (badge?.hasAttribute("data-simmer-badge")) {
    badge.remove();
  }
}

const SITE_CHROME =
  "footer, nav, header, #globalheader, #globalfooter, #ac-globalfooter, #ac-globalheader, #globalnav, #ac-globalnav, .globalheader, .globalfooter, [role='banner'], [role='contentinfo']";

const OWNED_ROOT = `${SITE_CHROME}, #simmer-root`;

/** Drop page shells and anything sitting in site chrome. Keeps the pay control itself. */
export function scopeBlockedControls(nodes: readonly Element[]): Element[] {
  const kept: Element[] = [];
  for (const node of nodes) {
    if (node.closest(OWNED_ROOT) || isControlContainer(node)) {
      continue;
    }
    kept.push(node);
  }
  return kept.filter((node) => !kept.some((other) => other !== node && node.contains(other)));
}

/** Checkout and express-pay leaves for this page. Containers that merely wrap them are left out. */
export function collectPayControls(doc: Document, kind: ApplePage): HTMLElement[] {
  return [...doc.querySelectorAll(PAY_CONTROLS)].flatMap((node) => {
    const element = asHtmlElement(node);
    if (!element || !shouldBlock(element, kind)) {
      return [];
    }
    return [element];
  });
}

function shouldBlock(node: Element, kind: ApplePage): boolean {
  if (node.closest(OWNED_ROOT) || isControlContainer(node)) {
    return false;
  }
  const control = controlFrom(node);
  return control !== null && isBlockedControl(control, kind);
}

/** A shell whose text happens to include "Check Out" or "Apple Pay" because the real buttons sit inside it. */
function isControlContainer(node: Element): boolean {
  for (const inner of node.querySelectorAll(NESTED_INTERACTIVE)) {
    if (inner !== node) {
      return true;
    }
  }
  return false;
}

function asHtmlElement(node: Element): HTMLElement | null {
  if (typeof HTMLElement === "undefined") {
    return node as HTMLElement;
  }
  return node instanceof HTMLElement ? node : null;
}

function ensureBadge(node: Element): void {
  const next = node.nextElementSibling;
  if (next?.hasAttribute("data-simmer-badge")) {
    if (next.textContent !== "Marinating") {
      next.textContent = "Marinating";
    }
    return;
  }
  const badge = node.ownerDocument.createElement("span");
  badge.setAttribute("data-simmer-badge", "1");
  badge.textContent = "Marinating";
  node.after(badge);
}

function controlElement(target: EventTarget | null): Element | null {
  const element = eventElement(target);
  return element?.closest(PAY_CONTROLS) ?? null;
}

function eventElement(target: EventTarget | null): Element | null {
  if (isElementTarget(target)) {
    return target;
  }
  if (typeof target === "object" && target !== null && "parentElement" in target) {
    const parent = (target as Node).parentElement;
    return parent ?? null;
  }
  return null;
}

function controlFrom(node: Element): BagControl | null {
  return {
    tag: node.tagName.toLowerCase(),
    text: node.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
    ariaLabel: node.getAttribute("aria-label") ?? "",
  };
}

function isElementTarget(target: EventTarget | null): target is Element {
  return typeof target === "object" && target !== null && "nodeType" in target && (target as Node).nodeType === 1;
}
