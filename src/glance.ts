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
  mathAction?: "sleep" | "unlock";
  mathWaitMonths?: number;
  mathSavingsCents?: number;
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
  necessity?: "necessary" | "unnecessary" | null;
  necessitySource?: string | null;
  necessityReason?: string | null;
  userImpulseScore?: number | null;
  justificationGrade?: number | null;
  gradeSource?: string | null;
  gradeReason?: string | null;
  purchaseScore?: number | null;
  scoreBucket?: "free" | "soft" | "strict" | null;
  scoreReason?: string | null;
};

export type LockGlance = "Marinating" | "Unlocked" | "Paused";

/** Header for the popup. A live bag lock wins over a resting vault. */
export function lockGlance(items: readonly GlanceItem[]): LockGlance {
  if (items.some((item) => item.status === "locked")) {
    return "Marinating";
  }
  if (items.some((item) => item.status === "vault")) {
    return "Paused";
  }
  return "Unlocked";
}

/** One plain sentence for the card and popup. No score numbers. */
export function oneLineVerdict(item: GlanceItem, nowMs: number): string {
  if (item.necessity === "necessary" && item.purchaseScore == null) {
    return "This is a necessary buy.";
  }
  if (item.purchaseScore != null && item.scoreBucket === "strict") {
    return "This one can wait.";
  }
  if (item.purchaseScore != null && item.scoreBucket === "soft") {
    return "Worth a pause before buying.";
  }
  if (item.purchaseScore != null && item.scoreBucket === "free") {
    return "Looks fine to buy.";
  }
  if (item.status === "vault") {
    return vaultLine(item.vaultUntil, nowMs);
  }
  if (item.userImpulseScore != null && item.purchaseScore == null && item.status === "locked") {
    return "Reply and say why you want this.";
  }
  if (item.status === "unlocked") {
    return "Looks fine to buy.";
  }
  const decision = item.decision;
  if (!decision || decision.action === "unlock" || decision.savingsCents <= 0) {
    return "Looks fine to buy.";
  }
  const months = decision.waitMonths > 0 ? decision.waitMonths : 1;
  const monthWord = months === 1 ? "month" : "months";
  return `Waiting about ${months} ${monthWord} saves about ${approxUsd(decision.savingsCents)}.`;
}

export type BreakdownLine = {
  label: string;
  value: string;
};

/** Detail for one expanded card. Example offers appear only when they beat buying now. */
export function breakdownLines(item: GlanceItem): BreakdownLine[] {
  const decision = item.decision;
  const lines: BreakdownLine[] = [];
  appendScoreLines(item, lines);
  if (!decision) {
    if (lines.length === 0) {
      lines.push({ label: "Verdict", value: "No read yet" });
    }
    return lines;
  }
  const scored = item.scoreBucket === "soft" || item.scoreBucket === "strict";
  if (scored) {
    lines.push({ label: "Alternative", value: alternativeGlance(decision) });
  }
  const months = decision.waitMonths > 0 ? decision.waitMonths : 0;
  if (!scored) {
    lines.push({
      label: "Wait",
      value: decision.action === "sleep" && months > 0 ? `${months} months` : "Buy now",
    });
  }
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
  if (!scored && decision.offerName && decision.savingsCents > 0 && decision.action === "sleep") {
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

function appendScoreLines(item: GlanceItem, lines: BreakdownLine[]): void {
  if (item.necessity) {
    const source = item.necessitySource ?? "keywords";
    const reason = item.necessityReason ? `. ${item.necessityReason}` : "";
    lines.push({ label: "Necessity", value: `${item.necessity} (${source})${reason}` });
  }
  if (item.userImpulseScore != null) {
    lines.push({ label: "Impulse", value: `${item.userImpulseScore} (mock history)` });
  }
  if (item.justificationGrade != null) {
    const signed = item.justificationGrade > 0 ? `+${item.justificationGrade}` : String(item.justificationGrade);
    const because = item.gradeReason ? `. ${item.gradeReason}` : "";
    lines.push({ label: "Grade", value: `${signed} (${item.gradeSource ?? "keywords"})${because}` });
  }
  if (item.purchaseScore != null && item.userImpulseScore != null && item.justificationGrade != null) {
    const signed = item.justificationGrade > 0 ? `+${item.justificationGrade}` : String(item.justificationGrade);
    lines.push({
      label: "Purchase score",
      value: `${item.purchaseScore} = ${item.userImpulseScore} + ${signed}`,
    });
  }
  if (item.scoreBucket === "strict") {
    lines.push({ label: "Time limit", value: "Checkout stays paused until the hold ends." });
  } else if (item.scoreBucket === "soft") {
    lines.push({ label: "Time limit", value: "Optional. Sleep on it is not required." });
  } else if (item.scoreBucket === "free") {
    lines.push({ label: "Time limit", value: "None. The bag is unlocked." });
  }
}

function alternativeGlance(decision: GlanceDecision): string {
  const months = decision.mathWaitMonths && decision.mathWaitMonths > 0 ? decision.mathWaitMonths : decision.waitMonths;
  const savings = decision.mathSavingsCents && decision.mathSavingsCents > 0 ? decision.mathSavingsCents : decision.savingsCents;
  if (decision.offerName && savings > 0) {
    const wait = months > 0 ? `${months} months` : "a while";
    return `Wait ${wait} for the ${decision.offerName}. Saves ${formatUsd(savings)}. Example data, not a current carrier deal.`;
  }
  if ((decision.mathAction === "sleep" || decision.action === "sleep") && savings > 0 && months > 0) {
    return `Wait ${months} months. Saves ${formatUsd(savings)}.`;
  }
  return "Waiting does not cost less than buying now.";
}

function vaultLine(vaultUntil: string | null, nowMs: number): string {
  if (!vaultUntil) {
    return "This one can wait.";
  }
  const left = Date.parse(vaultUntil) - nowMs;
  if (left <= 0) {
    return "The pause is over.";
  }
  const hours = Math.max(1, Math.ceil(left / 3_600_000));
  return hours === 1 ? "Ready again in 1 hour." : `Ready again in ${hours} hours.`;
}

function approxUsd(cents: number): string {
  const dollars = Math.max(0, Math.round(cents / 100));
  return `$${dollars.toLocaleString("en-US")}`;
}
