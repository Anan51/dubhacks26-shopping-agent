import { interpretBag, parsePriceCents, type InterpretedBag } from "../../src/apple-bag.js";
import { formatUsd } from "../../src/format.js";

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

/** Apple's bag copy uses non-breaking spaces, including inside "(1 m)". */
export function normalizeBagText(value: string): string {
  return value.replaceAll("\u00a0", " ").replace(/\s+/g, " ").trim();
}

export function quantityTotalLabel(quantity: number, totalCents: number): string {
  return `${quantity} · ${formatUsd(totalCents)}`;
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
      const item = readRow(row);
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

function readRow(row: Element): BagLineItem | null {
  const name = nameFrom(row);
  if (!name || isMisleadingProductName(name)) {
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
