import { MONTHLY_PAYMENT_CENTS } from "./heuristic.js";
import { formatUsd } from "./format.js";
import { assertNever, type Decision, type ReasonCode, type Signals } from "./types.js";

/** Plain-language why. Does not choose buy vs wait. */
export function phraseDecision(decision: Decision, signals: Signals): string {
  const lead =
    decision.action === "buy"
      ? "Buy — I'd go ahead with this one."
      : "Wait — I'd hold off on this upgrade.";
  const today = `Today you'd lay out ${formatUsd(decision.netNowCents)}. That's ${formatUsd(signals.dueTodayCents)} due today, plus ${formatUsd(decision.owedNowCents)} still owed, minus ${formatUsd(decision.tradeInNowCents)} trade-in.`;
  const later = `In ${decision.horizonMonths} months it's about ${formatUsd(decision.netLaterCents)}. Trade-in moves from ${formatUsd(decision.tradeInNowCents)} to ${formatUsd(decision.tradeInLaterCents)}, and the balance goes from ${formatUsd(decision.owedNowCents)} to ${formatUsd(decision.owedLaterCents)} if you keep paying ${formatUsd(MONTHLY_PAYMENT_CENTS)} a month.`;
  const plan =
    signals.monthlyPlanCents > 0
      ? `The line itself is another ${formatUsd(signals.monthlyPlanCents)} a month.`
      : "";
  const because = decision.reasons.map((code) => reasonSentence(code, decision, signals)).join(" ");
  const quote = signals.problemText.length > 0 ? `You said: "${signals.problemText.slice(0, 180)}".` : "";
  const parts = [lead, today, later, plan, because, quote, "Trade-in numbers are a synthetic curve, not a carrier quote."];
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Optional wording pass. The template is the result whenever the key is missing,
 * the call fails, or the model changes the buy/wait call.
 */
export async function polishPhrase(
  template: string,
  action: Decision["action"],
  apiKey: string | undefined,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!apiKey) {
    return template;
  }
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Rewrite this text message in a warm, brief voice.",
                    "Keep the first word as Buy or Wait, matching the original call.",
                    "Keep every dollar amount. Do not add facts or change the recommendation.",
                    "Reply with only the message.",
                    "",
                    template,
                  ].join("\n"),
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok) {
      return template;
    }
    const body = (await response.json()) as GeminiResponse;
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text || !keepsCall(text, action)) {
      return template;
    }
    return text;
  } catch {
    return template;
  }
}

function keepsCall(text: string, action: Decision["action"]): boolean {
  const opening = text.slice(0, 24).toLowerCase();
  if (action === "buy") {
    return opening.startsWith("buy");
  }
  return opening.startsWith("wait");
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
    default:
      return assertNever(code);
  }
}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};
