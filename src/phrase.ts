import { formatUsd } from "./format.js";
import { DEFAULT_XAI_MODEL, DEFAULT_XAI_TIMEOUT_MS, grokChat } from "./grok.js";
import { MONTHLY_PAYMENT_CENTS } from "./heuristic.js";
import { assertNever, type Decision, type SignalSource, type Signals } from "./types.js";

/** Plain-language verdict. Does not choose sleep versus unlock. */
export function phraseDecision(decision: Decision, signals: Signals, source: SignalSource | null = "keywords"): string {
  const lead = verdictLead(decision);
  const numbers = `Buying now is ${formatUsd(decision.costNowCents)} (the ${formatUsd(decision.newDeviceCents)} bag, plus ${formatUsd(decision.financingNowCents)} still owed, minus ${formatUsd(decision.tradeInNowCents)} trade-in). In ${decision.waitMonths || 0} months it is ${formatUsd(decision.costLaterCents)}, with trade-in at ${formatUsd(decision.tradeInLaterCents)} and ${formatUsd(decision.financingLaterCents)} left on the old phone if you keep paying ${formatUsd(MONTHLY_PAYMENT_CENTS)} a month.`;
  const said = signals.problemText.length > 0 ? `You said "${signals.problemText}".` : "";
  return [lead, numbers, said, parsedLine(source), "Trade-in values and the $35 financing are example data, not a carrier quote."].filter((part) => part.length > 0).join("\n\n");
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
  switch (decision.action) {
    case "sleep":
      return `Waiting ${decision.waitMonths} months saves you ${formatUsd(decision.savingsCents)}. Sleep on it?`;
    case "unlock":
      return "Unlock — waiting does not cost less than buying now.";
    default:
      return assertNever(decision.action);
  }
}

function parsedLine(source: SignalSource | null): string {
  switch (source) {
    case "grok":
      return "Parsed with Grok.";
    case "keywords":
      return "Parsed with keywords.";
    case null:
      return "Using example trade-in and financing until you reply.";
    default:
      return assertNever(source);
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
