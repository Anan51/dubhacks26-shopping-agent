import { interpretBag, parsePriceCents, type InterpretedBag } from "../../src/apple-bag.js";
import { formatUsd } from "../../src/format.js";
import { AMAZON_BAG_ITEM, AMAZON_BAG_TOTAL } from "./stores/amazon.js";
import { mutationIsOurs } from "./page-observer.js";

export type BagLineItem = {
  position: number | null;
  name: string;
  quantity: number | null;
  linePriceCents: number | null;
};

export type PageBag = InterpretedBag & {
  items: BagLineItem[];
  quantity: number | null;
  subtotalCents: number | null;
};

const BAG_LABEL = /^(bag|shopping bag|your bag|apple bag|review bag|review your bag)$/i;
const QUANTITY_LABEL = /^\d+\+$/;

export function normalizeBagText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function quantityTotalLabel(quantity: number, totalCents: number): string {
  return `${quantity} · ${formatUsd(totalCents)}`;
}

/**
 * Identity of the bag we would post: first item, its quantity, and the bag total.
 * Null when the page has no readable line, so a half-rendered update is not a new cart.
 */
export function bagContentKey(bag: PageBag): string | null {
  if (!bag.parsed || bag.totalCents == null || bag.itemNames.length === 0) {
    return null;
  }
  const name = bag.itemNames[0];
  if (!name) {
    return null;
  }
  return `${bag.quantity ?? ""}|${bag.totalCents}|${name}`;
}

/** Items and total, used to skip a re-render when a mutation did not change the bag. */
export function bagParseKey(bag: PageBag): string | null {
  if (bag.totalCents == null || bag.itemNames.length === 0) {
    return null;
  }
  return `${bag.itemNames.join("\n")}|${bag.quantity ?? ""}|${bag.totalCents}`;
}

/** Post only when a re-read differs from the bag already on the server. */
export function bagReadAction(postedKey: string | null, bag: PageBag): "post" | "keep" {
  const key = bagContentKey(bag);
  if (!key || key === postedKey) {
    return "keep";
  }
  return "post";
}

/** Title, a bag heading, or the word "bag" must never be sent to the classifier. */
export function isMisleadingProductName(name: string, root?: ParentNode): boolean {
  const normalized = normalizeBagText(name);
  if (!normalized || BAG_LABEL.test(normalized) || QUANTITY_LABEL.test(normalized)) {
    return true;
  }
  if (!root) {
    return false;
  }
  const title = normalizeBagText(root.ownerDocument?.title ?? "");
  if (title.length > 0 && title.toLowerCase() === normalized.toLowerCase()) {
    return true;
  }
  const headings = root.querySelectorAll("h1, h2, h3");
  for (const heading of headings) {
    if (heading.closest("li[data-autom^='bag-item-'], li.rs-bag-item")) {
      continue;
    }
    const text = normalizeBagText(heading.textContent ?? "");
    if (text.toLowerCase() === normalized.toLowerCase() && /\bbag\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Apple line items first (`data-autom`), then the same row's class hooks, then the
 * text reader used by the local fallback bag. A missing line item stays unknown.
 */
export function readPageBag(root: ParentNode): PageBag {
  const rows = itemRows(root);
  if (rows.length > 0) {
    return readStructured(root, rows);
  }
  return readTextFallback(root);
}

function readStructured(root: ParentNode, rows: readonly Element[]): PageBag {
  const items = rows
    .flatMap((row) => {
      const item = readRow(row, root);
      return item ? [item] : [];
    })
    .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER));
  const subtotalCents = summaryCents(root, "bagrs-summary-subtotalvalue");
  if (items.length === 0) {
    return {
      items: [],
      itemNames: [],
      quantity: null,
      subtotalCents,
      totalCents: null,
      parsed: false,
    };
  }
  const first = items[0];
  const totalCents = summaryCents(root, "bagtotalvalue") ?? subtotalCents ?? first?.linePriceCents ?? null;
  return {
    items,
    itemNames: items.map((item) => item.name),
    quantity: first?.quantity ?? null,
    subtotalCents,
    totalCents,
    parsed: totalCents !== null && totalCents > 0,
  };
}

function itemRows(root: ParentNode): Element[] {
  const primary = [...root.querySelectorAll('li[data-autom^="bag-item-"]')];
  if (primary.length > 0) {
    return primary;
  }
  return [...root.querySelectorAll("li.rs-bag-item")];
}

function readRow(row: Element, page: ParentNode): BagLineItem | null {
  const name = nameFrom(row);
  if (!name || isMisleadingProductName(name, page)) {
    return null;
  }
  return {
    position: positionFrom(row),
    name,
    quantity: quantityFrom(row),
    linePriceCents: linePriceFrom(row),
  };
}

function nameFrom(row: ParentNode): string | null {
  const node =
    row.querySelector('[data-autom="bag-item-name"]') ??
    row.querySelector("h2.rs-iteminfo-title a") ??
    row.querySelector(".rs-iteminfo-title a");
  if (!node) {
    return null;
  }
  const name = normalizeBagText(node.textContent ?? "");
  return name.length > 0 ? name : null;
}

function quantityFrom(row: ParentNode): number | null {
  const select =
    row.querySelector('select[data-autom="item-quantity-dropdown"]') ??
    row.querySelector("select.rs-quantity-dropdown:not(.rs-quantity-hidden-select)");
  if (!select || select.tagName !== "SELECT") {
    return null;
  }
  const control = select as HTMLSelectElement;
  if (control.classList.contains("rs-quantity-hidden-select") || control.getAttribute("aria-hidden") === "true") {
    return null;
  }
  const raw = control.value.trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const quantity = Number(raw);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return null;
  }
  return quantity;
}

function linePriceFrom(row: ParentNode): number | null {
  const node = row.querySelector('[data-autom="Monthly_price"] p') ?? row.querySelector(".rs-iteminfo-price p");
  if (!node) {
    return null;
  }
  return parsePriceCents(normalizeBagText(node.textContent ?? ""));
}

function summaryCents(root: ParentNode, autom: string): number | null {
  const node = root.querySelector(`[data-autom="${autom}"]`);
  if (!node) {
    return null;
  }
  return parsePriceCents(normalizeBagText(node.textContent ?? ""));
}

function positionFrom(row: Element): number | null {
  const match = /^bag-item-(\d+)$/.exec(row.getAttribute("data-autom") ?? "");
  if (!match?.[1]) {
    return null;
  }
  const position = Number(match[1]);
  return Number.isSafeInteger(position) ? position : null;
}

function readTextFallback(root: ParentNode): PageBag {
  const interpreted = interpretBag(linesFrom(root));
  const names = interpreted.itemNames.filter((name) => !isMisleadingProductName(name, root));
  if (names.length === 0) {
    return {
      items: [],
      itemNames: [],
      quantity: null,
      subtotalCents: null,
      totalCents: null,
      parsed: false,
    };
  }
  return {
    items: [],
    itemNames: names,
    quantity: null,
    subtotalCents: null,
    totalCents: interpreted.totalCents,
    parsed: interpreted.parsed && interpreted.totalCents !== null && interpreted.totalCents > 0,
  };
}

function linesFrom(root: ParentNode): string[] {
  const element = textRoot(root);
  if (!element) {
    return [];
  }
  const raw = typeof element.innerText === "string" ? element.innerText : blockLines(element);
  return raw
    .split(/\n+/)
    .map((line) => normalizeBagText(line))
    .filter((line) => line.length > 0 && line.length < 180);
}

function blockLines(element: HTMLElement): string {
  const blocks = [...element.querySelectorAll("h1, h2, h3, p, li, label, option")];
  if (blocks.length === 0) {
    return element.textContent ?? "";
  }
  return blocks.map((node) => node.textContent ?? "").join("\n");
}

function textRoot(root: ParentNode): HTMLElement | null {
  if (root.nodeType === 1) {
    return root as HTMLElement;
  }
  if (root.nodeType === 9) {
    return (root as Document).body;
  }
  return null;
}

/** Wait for a burst of bag edits (quantity, then the total) to settle before re-reading. */
export const BAG_READ_DEBOUNCE_MS = 400;

const BAG_OBSERVE: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["value", "selected"],
};

export type BagWatch = {
  /** True while the observed bag nodes are still in the document. */
  connected: () => boolean;
  /** Re-bind after Apple replaces the bag subtree. False when no bag is on the page. */
  retarget: () => boolean;
  disconnect: () => void;
};

type BagTimer = {
  schedule: (run: () => void, ms: number) => unknown;
  cancel: (id: unknown) => void;
};

/**
 * The smallest nodes that contain the line item and the bag total.
 * Header and footer mutations stay outside this set.
 */
export function bagWatchTargets(root: ParentNode): Element[] {
  const item = root.querySelector('li[data-autom^="bag-item-"], li.rs-bag-item') ?? root.querySelector(AMAZON_BAG_ITEM);
  const total = root.querySelector('[data-autom="bagtotalvalue"]') ?? root.querySelector(AMAZON_BAG_TOTAL);
  if (!item && !total) {
    return [];
  }
  const shared = item && total ? ancestorWithinBag(item, total) : null;
  if (shared && !containsSiteChrome(shared)) {
    return [shared];
  }
  const targets: Element[] = [];
  if (item) {
    addTarget(targets, watchHost(item));
  }
  if (total) {
    addTarget(targets, watchHost(total));
  }
  return targets;
}

/** Observe the bag area and coalesce edits into one callback. */
export function watchBagDom(doc: Document, onChange: () => void, timer?: BagTimer, debounceMs = BAG_READ_DEBOUNCE_MS): BagWatch {
  const view = doc.defaultView;
  const schedule = timer?.schedule ?? ((run: () => void, ms: number) => (view ?? globalThis).setTimeout(run, ms));
  const cancel = timer?.cancel ?? ((id: unknown) => (view ?? globalThis).clearTimeout(id as ReturnType<typeof setTimeout>));
  const ObserverCtor = view?.MutationObserver ?? globalThis.MutationObserver;
  let observer: MutationObserver | null = null;
  let targets: Element[] = [];
  let timerId: unknown = 0;
  let timerLive = false;

  const kick = () => {
    if (timerLive) {
      cancel(timerId);
    }
    timerLive = true;
    timerId = schedule(() => {
      timerLive = false;
      onChange();
    }, debounceMs);
  };

  const disconnectObserver = () => {
    observer?.disconnect();
    observer = null;
    targets = [];
  };

  const retarget = (): boolean => {
    const next = bagWatchTargets(doc);
    if (next.length === 0) {
      disconnectObserver();
      return false;
    }
    if (observer && sameTargets(targets, next) && next.every((node) => node.isConnected)) {
      return true;
    }
    disconnectObserver();
    observer = new ObserverCtor((records) => {
      if (records.every(mutationIsOurs)) {
        return;
      }
      kick();
    });
    targets = next;
    for (const target of next) {
      observer.observe(target, BAG_OBSERVE);
    }
    return true;
  };

  retarget();
  return {
    connected: () => targets.length > 0 && targets.every((node) => node.isConnected),
    retarget,
    disconnect: () => {
      if (timerLive) {
        cancel(timerId);
      }
      timerLive = false;
      disconnectObserver();
    },
  };
}

function ancestorWithinBag(item: Element, total: Element): Element | null {
  if (item.contains(total)) {
    return hostWithinBag(item);
  }
  if (total.contains(item)) {
    return hostWithinBag(total);
  }
  const ancestors = new Set<Element>();
  for (let current: Element | null = item; current && !isShell(current); current = current.parentElement) {
    ancestors.add(current);
  }
  for (let current: Element | null = total; current && !isShell(current); current = current.parentElement) {
    if (ancestors.has(current)) {
      return current;
    }
  }
  return null;
}

function hostWithinBag(node: Element): Element {
  const parent = node.parentElement;
  if (parent && !isShell(parent)) {
    return parent;
  }
  return node;
}

const CHROME_INSIDE =
  "nav, footer, header, #globalnav, #globalheader, #ac-globalnav, #ac-globalfooter, #globalfooter, #ac-globalheader, [role='banner'], [role='contentinfo']";

function watchHost(node: Element): Element {
  const host = hostWithinBag(node);
  if (containsSiteChrome(host)) {
    return node;
  }
  return host;
}

/** #page on apple.com wraps the nav and the footer. Watching it re-reads the bag on every header edit. */
function containsSiteChrome(node: Element): boolean {
  return node.matches(CHROME_INSIDE) || node.querySelector(CHROME_INSIDE) !== null;
}

function isShell(node: Element): boolean {
  return node.tagName === "BODY" || node.tagName === "HTML";
}

function addTarget(targets: Element[], next: Element): void {
  if (targets.some((target) => target === next || target.contains(next))) {
    return;
  }
  const covering = targets.findIndex((target) => next.contains(target));
  if (covering >= 0) {
    targets.splice(covering, 1);
  }
  targets.push(next);
}

function sameTargets(left: readonly Element[], right: readonly Element[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}
