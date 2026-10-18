import { breakdownLines, oneLineVerdict, type BreakdownLine, type GlanceItem } from "../../src/glance.js";

export const PAUSED_LABEL = "Paused — reply to Simmer's iMessage";
export const OPTIONAL_PAUSE_LABEL = "Paused (optional)";
export const VAULT_LABEL = "In the vault";
export const OK_LABEL = "OK to buy";
export const NECESSARY_LABEL = "Necessary buy";
export const EXAMPLE_NOTE = "Example figures.";

export type ReplyPing = { delivered: boolean } | null;

/**
 * Cart has no field named "awaiting reply".
 * `lastPing` is the outbound checkout ping. `justificationGrade` stays null until the shopper answers.
 * The reply line is only for a delivered ping on a bag that is still locked and still unanswered.
 */
export function awaitingShopperReply(item: {
  status: GlanceItem["status"];
  justificationGrade?: number | null;
  lastPing?: ReplyPing;
}): boolean {
  return item.status === "locked" && item.justificationGrade == null && item.lastPing?.delivered === true;
}

const HIDDEN_BREAKDOWN = new Set(["Impulse", "Grade", "Purchase score", "Time limit"]);

const EXAMPLE_MARKERS = ["Example data, not a current carrier deal.", "Example data, not a carrier quote.", "Example data."];

export type PopupDetail = {
  lines: BreakdownLine[];
  exampleNote: string | null;
};

/** The popup shows one bag: the newest cart for this shopper. An unknown shopper sees none. */
export function newestCart<T extends { userId: string | null; createdAt?: string }>(
  carts: readonly T[],
  userId: string,
): T | null {
  const id = userId.trim();
  if (id.length === 0) {
    return null;
  }
  const mine = carts.filter((cart) => cart.userId === id);
  const first = mine[0];
  if (!first) {
    return null;
  }
  return mine.reduce((best, cart) => ((cart.createdAt ?? "") > (best.createdAt ?? "") ? cart : best), first);
}

/** Plain status for the current bag. Score and impulse numbers stay off this line. */
export function plainCartLabel(item: GlanceItem & { lastPing?: ReplyPing }, nowMs: number): string {
  if (item.necessity === "necessary") {
    return NECESSARY_LABEL;
  }
  if (awaitingShopperReply(item)) {
    return PAUSED_LABEL;
  }
  if (item.status === "vault") {
    return VAULT_LABEL;
  }
  if (item.scoreBucket === "soft") {
    return OPTIONAL_PAUSE_LABEL;
  }
  if (item.scoreBucket === "free" || item.status === "unlocked") {
    return OK_LABEL;
  }
  const decision = item.decision;
  if (!decision || decision.action === "unlock" || decision.savingsCents <= 0) {
    return OK_LABEL;
  }
  const waited = oneLineVerdict(item, nowMs);
  if (/\$\d/.test(waited)) {
    return `${waited}. ${EXAMPLE_NOTE}`;
  }
  return waited;
}

/** Expanded detail without score jargon. The example note appears only beside example figures. */
export function presentBreakdown(item: GlanceItem, nowMs: number): PopupDetail {
  let example = false;
  const lines = breakdownLines(item).flatMap((line) => {
    if (HIDDEN_BREAKDOWN.has(line.label)) {
      return [];
    }
    const stripped = stripExample(line.value);
    if (stripped.example) {
      example = true;
    }
    const value = line.label === "Necessity" ? plainNecessity(stripped.value) : stripped.value;
    if (!value) {
      return [];
    }
    return [{ label: line.label, value }];
  });
  if (lines.length === 0) {
    lines.push({ label: "Status", value: plainCartLabel(item, nowMs) });
  }
  return { lines, exampleNote: example ? EXAMPLE_NOTE : null };
}

function stripExample(value: string): { value: string; example: boolean } {
  let next = value;
  let example = false;
  for (const marker of EXAMPLE_MARKERS) {
    if (!next.includes(marker)) {
      continue;
    }
    example = true;
    next = next.replaceAll(marker, "").trim();
  }
  return { value: next, example };
}

function plainNecessity(value: string): string {
  const necessary = value.startsWith("necessary");
  const reason = value.split(". ").slice(1).join(". ").trim();
  const label = necessary ? NECESSARY_LABEL : "Not a necessary buy";
  return reason ? `${label}. ${reason}` : label;
}
