import { alternativeById } from "./alternatives.js";
import { formatUsd } from "./format.js";
import { DEFAULT_XAI_MODEL, grokChat } from "./grok.js";
import { MONTHLY_PAYMENT_CENTS } from "./heuristic.js";
import { assertNever, type Decision, type ReasonCode, type SignalSource, type Signals } from "./types.js";

/** Plain-language why. Does not choose buy vs wait. */
export function phraseDecision(decision: Decision, signals: Signals, source: SignalSource = "keywords"): string {
  const lead = verdictLead(decision.action);
  const today = `Today you'd lay out ${formatUsd(decision.netNowCents)}. That's ${formatUsd(signals.dueTodayCents)} due today, plus ${formatUsd(decision.owedNowCents)} still owed, minus ${formatUsd(decision.tradeInNowCents)} trade-in.`;
  const later = `In ${decision.horizonMonths} months it's about ${formatUsd(decision.netLaterCents)}. Trade-in moves from ${formatUsd(decision.tradeInNowCents)} to ${formatUsd(decision.tradeInLaterCents)}, and the balance goes from ${formatUsd(decision.owedNowCents)} to ${formatUsd(decision.owedLaterCents)} if you keep paying ${formatUsd(MONTHLY_PAYMENT_CENTS)} a month.`;
  const plan =
    signals.monthlyPlanCents > 0
      ? `The line itself is another ${formatUsd(signals.monthlyPlanCents)} a month.`
      : "";
  const because = decision.reasons.map((code) => reasonSentence(code, decision, signals)).join(" ");
  const quote =
    decision.action === "better" || signals.problemText.length === 0
      ? ""
      : `You said: "${signals.problemText.slice(0, 180)}".`;
  const parsedWith = source === "grok" ? "Parsed with Grok." : "Parsed with keywords.";
  const parts = [lead, today, later, plan, because, quote, parsedWith, "Trade-in numbers are a synthetic curve, not a carrier quote."];
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Optional wording pass through the Grok API. The template is the result whenever
 * XAI_API_KEY is missing, the call fails, or the model changes the buy/wait call.
 */
export async function polishPhrase(
  template: string,
  action: Decision["action"],
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  model: string = DEFAULT_XAI_MODEL,
): Promise<string> {
  if (!apiKey) {
    return template;
  }
  const text = await grokChat({
    apiKey,
    model,
    fetchImpl,
    prompt: [
      "Rewrite this text message in a warm, brief voice.",
      "Keep the first word as Buy, Wait, or Better, matching the original call.",
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

function verdictLead(action: Decision["action"]): string {
  switch (action) {
    case "buy":
      return "Buy — I'd go ahead with this one.";
    case "wait":
      return "Wait — I'd hold off on this upgrade.";
    case "better":
      return "Better — a cheaper fix covers this.";
    default:
      return assertNever(action);
  }
}

function keepsCall(text: string, action: Decision["action"]): boolean {
  const opening = text.slice(0, 24).toLowerCase();
  switch (action) {
    case "buy":
      return opening.startsWith("buy");
    case "wait":
      return opening.startsWith("wait");
    case "better":
      return opening.startsWith("better");
    default:
      return assertNever(action);
  }
}

function reasonSentence(code: ReasonCode, decision: Decision, signals: Signals): string {
  switch (code) {
    case "unusable-phone":
      return "The phone you have isn't usable, so keeping it is a bad trade.";
    case "over-budget":
      return `That ${formatUsd(decision.netNowCents)} out of pocket is over your ${formatUsd(signals.budgetCents)} budget.`;
    case "young-and-working":
      return `It's ${signals.deviceAgeMonths} months old and still in decent shape, so this isn't the time to upgrade.`;
    case "upside-down":
      return `You still owe ${formatUsd(decision.upsideDownCents)} more than the trade-in, so upgrading means paying that gap today.`;
    case "waiting-saves-money":
      return `Waiting is cheaper by about ${formatUsd(decision.netNowCents - decision.netLaterCents)} because the balance falls faster than the trade-in.`;
    case "old-and-failing":
      return `It's ${signals.deviceAgeMonths} months old and not in good shape, and waiting doesn't clearly save money.`;
    case "default-wait":
      return "Nothing here beats keeping the phone you have.";
    case "better-option":
      return betterSentence(decision, signals);
    default:
      return assertNever(code);
  }
}

function betterSentence(decision: Decision, signals: Signals): string {
  if (decision.action !== "better") {
    return "A cheaper fix covers what you described.";
  }
  const alternative = alternativeById(decision.alternativeId);
  if (!alternative) {
    return "A cheaper fix covers what you described.";
  }
  const savings = signals.dueTodayCents - alternative.priceCents;
  const said = signals.problemText.length > 0 ? `You said "${signals.problemText}", so ` : "";
  return `${said}${problemLabel(signals.problems)}; an ${formatUsd(alternative.priceCents)} ${alternative.label} fixes it for ${formatUsd(savings)} less.`;
}

function problemLabel(problems: Signals["problems"]): string {
  if (problems.length === 0) {
    return "a named problem";
  }
  return problems.map((problem) => `${problem} problem`).join(" and ");
}
