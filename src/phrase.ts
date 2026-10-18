import { formatUsd } from "./format.js";
import { DEFAULT_XAI_MODEL, DEFAULT_XAI_TIMEOUT_MS, grokChat } from "./grok.js";
import { MONTHLY_PAYMENT_CENTS } from "./heuristic.js";
import { assertNever, type Decision, type MotiveSources, type SignalSource, type Signals } from "./types.js";

/** Plain-language verdict. Does not choose sleep versus unlock. */
export function phraseDecision(
  decision: Decision,
  signals: Signals,
  source: SignalSource | null = "keywords",
  motiveSources: MotiveSources | null = null,
): string {
  const lead = verdictLead(decision);
  const numbers = `Buying now is ${formatUsd(decision.costNowCents)} (the ${formatUsd(decision.newDeviceCents)} bag, plus ${formatUsd(decision.financingNowCents)} still owed, minus ${formatUsd(decision.tradeInNowCents)} trade-in). In ${decision.mathWaitMonths || decision.waitMonths || 0} months it is ${formatUsd(decision.costLaterCents)}, with trade-in at ${formatUsd(decision.tradeInLaterCents)} and ${formatUsd(decision.financingLaterCents)} left on the old phone if you keep paying ${formatUsd(MONTHLY_PAYMENT_CENTS)} a month.`;
  const said = signals.reasonText.length > 0 ? `You said "${signals.reasonText}".` : signals.problemText.length > 0 ? `You said "${signals.problemText}".` : "";
  const offerNote = decision.offerName
    ? `${decision.offerName} is example data, not a current T-Mobile or carrier deal.`
    : "";
  return [lead, numbers, said, signalReport(decision, signals, source, motiveSources), offerNote, "Trade-in values and the $35 financing are example data, not a carrier quote."].filter((part) => part.length > 0).join("\n\n");
}

export async function polishPhrase(
  template: string,
  action: Decision["action"],
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  model: string = DEFAULT_XAI_MODEL,
  timeoutMs: number = DEFAULT_XAI_TIMEOUT_MS,
): Promise<string> {
  if (!apiKey) {
    return template;
  }
  const text = await grokChat({
    apiKey,
    model,
    timeoutMs,
    fetchImpl,
    prompt: [
      "Rewrite this text message in a warm, brief voice.",
      "Keep the first word as Waiting or Unlock, matching the original call.",
      "Keep every dollar amount. Do not add facts or change the recommendation.",
      "Reply with only the message.",
      "",
      template,
    ].join("\n"),
  });
  if (!text || !keepsCall(text, action)) {
    return template;
  }
  return text;
}

function verdictLead(decision: Decision): string {
  switch (decision.signalEffect) {
    case "need_unlock":
      return "Unlock — you need a working phone, so the savings do not decide this.";
    case "want_sleep":
      return "Waiting — this is a want with low urgency. Sleep on it?";
    case "math":
      return mathLead(decision);
    default:
      return assertNever(decision.signalEffect);
  }
}

function mathLead(decision: Decision): string {
  if (decision.action === "sleep" && decision.offerName) {
    return `Waiting for the ${decision.offerName} saves about ${formatUsd(decision.savingsCents)}. Sleep on it?`;
  }
  switch (decision.action) {
    case "sleep":
      return `Waiting ${decision.waitMonths} months saves you ${formatUsd(decision.savingsCents)}. Sleep on it?`;
    case "unlock":
      return "Unlock — waiting does not cost less than buying now.";
    default:
      return assertNever(decision.action);
  }
}

function signalReport(decision: Decision, signals: Signals, source: SignalSource | null, motiveSources: MotiveSources | null): string {
  const sources = motiveSources ?? {
    needVsWant: source ?? "default",
    urgency: source ?? "default",
    currentPhoneBroken: source ?? "default",
    reasonText: source ?? "default",
  };
  const lines = [
    `Need vs want: ${signals.needVsWant} (${sources.needVsWant}).`,
    `Urgency: ${signals.urgency} (${sources.urgency}).`,
    `Current phone broken: ${signals.currentPhoneBroken ? "yes" : "no"} (${sources.currentPhoneBroken}).`,
    `Reason: ${signals.reasonText.length > 0 ? signals.reasonText : "none"} (${sources.reasonText}).`,
    effectLine(decision),
  ];
  return lines.join(" ");
}

function effectLine(decision: Decision): string {
  switch (decision.signalEffect) {
    case "need_unlock":
      return `Price math said ${decision.mathAction} (${formatUsd(decision.mathSavingsCents)} over ${decision.mathWaitMonths} months). A needed, broken phone with high urgency unlocked it.`;
    case "want_sleep":
      return `Price math said ${decision.mathAction}. A want with low urgency kept it marinating.`;
    case "math":
      return "Price math decided this. The motive signals did not override it.";
    default:
      return assertNever(decision.signalEffect);
  }
}

function keepsCall(text: string, action: Decision["action"]): boolean {
  const opening = text.slice(0, 24).toLowerCase();
  switch (action) {
    case "sleep":
      return opening.startsWith("waiting");
    case "unlock":
      return opening.startsWith("unlock");
    default:
      return assertNever(action);
  }
}
