import type { CartItem, ProblemTag } from "./types.js";

export type Alternative = {
  id: string;
  name: string;
  /** Used in the sentence, for example "battery swap". */
  label: string;
  priceCents: number;
  kind: CartItem["kind"];
  solves: readonly ProblemTag[];
  reason: string;
};

/** Fictional fixes. Not carrier quotes and not price predictions. */
export const ALTERNATIVES: readonly Alternative[] = [
  {
    id: "battery-swap",
    name: "Battery swap",
    label: "battery swap",
    priceCents: 8_900,
    kind: "accessory",
    solves: ["battery"],
    reason: "A new battery fixes a phone that dies mid-day.",
  },
  {
    id: "certified-refurb",
    name: "Certified refurb of the same model",
    label: "certified refurb",
    priceCents: 44_900,
    kind: "phone",
    solves: ["battery", "screen", "performance"],
    reason: "A refurbished unit of the same model covers a cracked screen or a dying battery.",
  },
  {
    id: "last-year-model",
    name: "Last year's model",
    label: "last year's model",
    priceCents: 54_900,
    kind: "phone",
    solves: ["screen", "performance"],
    reason: "Last year's model replaces a broken screen or a slow phone without the new price.",
  },
  {
    id: "cheaper-plan",
    name: "Keep your phone, cheaper plan",
    label: "cheaper plan",
    priceCents: 4_000,
    kind: "plan",
    solves: ["cost"],
    reason: "The phone can stay. A smaller synthetic plan cuts what you pay.",
  },
];

export function alternativeById(id: string): Alternative | undefined {
  return ALTERNATIVES.find((alternative) => alternative.id === id);
}

export function alternativeItem(alternative: Alternative): CartItem {
  return {
    id: alternative.id,
    kind: alternative.kind,
    name: alternative.name,
    detail: "Synthetic alternative",
    priceCents: alternative.priceCents,
    cadence: "once",
  };
}
