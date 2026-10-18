import { formatUsd } from "./format.js";

export type GlanceStatus = "locked" | "vault" | "unlocked";

export type GlanceDecision = {
  action: "sleep" | "unlock";
  waitMonths: number;
  savingsCents: number;
  offerName: string | null;
  costNowCents: number;
  costLaterCents: number;
  tradeInNowCents: number;
  tradeInLaterCents: number;
  financingNowCents: number;
  financingLaterCents: number;
};

export type GlanceSignals = {
  needVsWant?: string;
  urgency?: string;
  currentPhoneBroken?: boolean;
  reasonText?: string;
};

export type GlanceSources = {
  needVsWant: string;
  urgency: string;
  currentPhoneBroken: string;
  reasonText: string;
};

export type GlanceItem = {
  code: string;
  name: string;
  priceCents: number;
  status: GlanceStatus;
  vaultUntil: string | null;
  decision: GlanceDecision | null;
  signals: GlanceSignals;
  motiveSources: GlanceSources | null;
};

export type LockGlance = "Marinating" | "Unlocked" | "In the Vault";

/** Header for the popup. A live bag lock wins over a resting vault. */
export function lockGlance(items: readonly GlanceItem[]): LockGlance {
  if (items.some((item) => item.status === "locked")) {
    return "Marinating";
  }
  if (items.some((item) => item.status === "vault")) {
    return "In the Vault";
  }
  return "Unlocked";
}

/** One line for a card. No explanation. */
export function oneLineVerdict(item: GlanceItem, nowMs: number): string {
  if (item.status === "vault") {
    return vaultLine(item.vaultUntil, nowMs);
  }
  if (item.status === "unlocked") {
    return "Buy now";
  }
  const decision = item.decision;
  if (!decision || decision.action === "unlock" || decision.savingsCents <= 0) {
    return "Buy now";
  }
  const months = decision.waitMonths > 0 ? decision.waitMonths : 1;
  return `Wait ~${months} mo, save ~${approxUsd(decision.savingsCents)}`;
}

export type BreakdownLine = {
  label: string;
  value: string;
};

/** Detail for one expanded card. Example offers appear only when they beat buying now. */
export function breakdownLines(item: GlanceItem): BreakdownLine[] {
  const decision = item.decision;
  const lines: BreakdownLine[] = [];
  if (!decision) {
    lines.push({ label: "Verdict", value: "No read yet" });
    return lines;
  }
  const months = decision.waitMonths > 0 ? decision.waitMonths : 0;
  lines.push({
    label: "Wait",
    value: decision.action === "sleep" && months > 0 ? `${months} months` : "Buy now",
  });
  if (decision.action === "sleep" && decision.savingsCents > 0) {
    lines.push({ label: "Saved by waiting", value: formatUsd(decision.savingsCents) });
  }
  lines.push({
    label: "Trade-in",
    value: `${formatUsd(decision.tradeInNowCents)} now, ${formatUsd(decision.tradeInLaterCents)} later. Example data.`,
  });
  lines.push({
    label: "Financing",
    value: `${formatUsd(decision.financingNowCents)} owed, ${formatUsd(decision.financingLaterCents)} later. Example data.`,
  });
  if (decision.offerName && decision.savingsCents > 0 && decision.action === "sleep") {
    lines.push({
      label: "Example offer",
      value: `Waiting for the ${decision.offerName} saves ${formatUsd(decision.savingsCents)}. Example data, not a current carrier deal.`,
    });
  }
  const sources = item.motiveSources;
  lines.push({
    label: "Need vs want",
    value: `${item.signals.needVsWant ?? "unknown"} (${sources?.needVsWant ?? "default"})`,
  });
  lines.push({
    label: "Urgency",
    value: `${item.signals.urgency ?? "medium"} (${sources?.urgency ?? "default"})`,
  });
  lines.push({
    label: "Phone broken",
    value: `${item.signals.currentPhoneBroken ? "yes" : "no"} (${sources?.currentPhoneBroken ?? "default"})`,
  });
  if (item.signals.reasonText) {
    lines.push({ label: "Reason", value: `${item.signals.reasonText} (${sources?.reasonText ?? "default"})` });
  }
  lines.push({
    label: "Cost",
    value:
      decision.costLaterCents < 0
        ? `${formatUsd(decision.costNowCents)} now. Waiting costs less by ${formatUsd(decision.savingsCents)}.`
        : `${formatUsd(decision.costNowCents)} now, ${formatUsd(decision.costLaterCents)} if you wait`,
  });
  return lines;
}

function vaultLine(vaultUntil: string | null, nowMs: number): string {
  if (!vaultUntil) {
    return "Vault · 24h left";
  }
  const left = Date.parse(vaultUntil) - nowMs;
  if (left <= 0) {
    return "Vault over";
  }
  const hours = Math.max(1, Math.ceil(left / 3_600_000));
  return `Vault · ${hours}h left`;
}

function approxUsd(cents: number): string {
  const dollars = Math.max(0, Math.round(cents / 100));
  return `$${dollars.toLocaleString("en-US")}`;
}
