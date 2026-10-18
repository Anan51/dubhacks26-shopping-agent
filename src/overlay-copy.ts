import { formatUsd } from "./format.js";
import type { GlanceItem } from "./glance.js";

/** Card header. Example data is labeled only while a fallback bag or example figures are on screen. */
export function simmerKicker(showingExample: boolean): "Simmer" | "Simmer · example data" {
  return showingExample ? "Simmer · example data" : "Simmer";
}

/**
 * One sentence for why checkout is paused.
 * Default signal values stay hidden. No field names and no score math.
 */
export function pauseSentence(item: GlanceItem): string {
  const sources = item.motiveSources;
  const need = sources && sources.needVsWant !== "default" ? item.signals.needVsWant : undefined;
  const broken = sources && sources.currentPhoneBroken !== "default" ? item.signals.currentPhoneBroken : undefined;
  if (need === "want") {
    return "This looks like a want, not a need.";
  }
  if (need === "need" && broken === true) {
    return "This looks like a need, and your current phone is broken.";
  }
  if (need === "need") {
    return "This looks like a need.";
  }
  if (broken === true) {
    return "Your current phone is broken.";
  }
  if (broken === false) {
    return "Your current phone works, so waiting costs you nothing.";
  }
  return "Simmer paused this checkout until you reply by iMessage.";
}

/**
 * The price on the bag. "If you wait" is included only when that figure is real.
 * Example trade-in math is omitted, so a real bag shows the price now.
 */
export type AdviceChoice = "Buy" | "Wait" | "Skip";

/** Buy when the score is free, skip when it is strict, otherwise wait. */
export function adviceChoice(item: GlanceItem): AdviceChoice {
  if (item.scoreBucket === "free" || (item.scoreBucket == null && item.decision?.action === "unlock")) {
    return "Buy";
  }
  if (item.scoreBucket === "strict") {
    return "Skip";
  }
  return "Wait";
}

/** The second sentence. A specific why does not replace it. */
function adviceFollowThrough(choice: AdviceChoice): string {
  switch (choice) {
    case "Buy":
      return "You can check out after you press Unlock.";
    case "Skip":
      return "This one can wait.";
    case "Wait":
      return "Give it a little time before you check out.";
    default: {
      const unexpected: never = choice;
      return unexpected;
    }
  }
}

/**
 * The iMessage Simmer sends before the overlay may show Unlock.
 * The call and the follow-through travel in one body.
 */
export function adviceMessage(item: GlanceItem): string {
  const choice = adviceChoice(item);
  const why = pauseSentence(item);
  const follow = adviceFollowThrough(choice);
  if (why.startsWith("Simmer paused")) {
    return `${choice}. ${follow}`;
  }
  return `${choice}. ${why} ${follow}`;
}

export function priceLine(totalCents: number, wait: { cents: number; example: boolean } | null): string {
  const now = `Now: ${formatUsd(totalCents)}`;
  if (!wait || wait.example) {
    return now;
  }
  return `${now} · If you wait: ${formatUsd(wait.cents)} (estimate)`;
}
