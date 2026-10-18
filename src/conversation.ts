import { holdForUnlock, withCartFacts } from "./carts.js";
import { extractCartCode, extractSignals, pickShopperSignals, type ExtractOptions } from "./extract-signals.js";
import { personaFor } from "./history.js";
import { decide } from "./heuristic.js";
import { applyPurchaseScore, gradeJustification, syncFreeBandCopy } from "./impulse.js";
import { UPGRADE_PROMPT } from "./links.js";
import { adviceMessage } from "./overlay-copy.js";
import { parseLinkCommand, threadUserId } from "./phone-link.js";
import { phraseDecision } from "./phrase.js";
import type { PhoneLink } from "./store.js";
import type { Cart, ConversationContext, Session } from "./types.js";
import type { GlanceItem } from "./glance.js";

export type ApplyInput = {
  session: Session | null;
  conversationId: string;
  messageId: string;
  text: string;
  agentSenderId?: string;
  now: Date;
  demoReminderMs: number;
  loadCart: (code: string) => Cart | undefined;
  /** Phone thread with no cart code in the text. Photon replies land here. */
  resolveCart?: (conversationId: string) => Cart | undefined;
  /** Short link code from a text, mapped back to the shopper id registered with a cart. */
  resolveLinkCode?: (code: string) => string | null;
  extract?: ExtractOptions;
  /** Persist the cart while Grok is in flight so other pages can show it. */
  markReading?: (cart: Cart) => void;
};

export type ApplyResult = {
  session: Session;
  cart?: Cart;
  reply: string | null;
  duplicate: boolean;
  armReminder: boolean;
  disarmReminder: boolean;
  /** Set replied only after the advice text has been handed to the channel. */
  markReplied: boolean;
  phoneLink?: PhoneLink;
};

export async function applyTurn(input: ApplyInput): Promise<ApplyResult> {
  if (input.session?.lastInboundId === input.messageId) {
    return {
      session: input.session,
      reply: null,
      duplicate: true,
      armReminder: false,
      disarmReminder: false,
      markReplied: false,
    };
  }

  const nowIso = input.now.toISOString();
  const session: Session = input.session
    ? {
        ...input.session,
        signals: { ...input.session.signals },
        turns: [...input.session.turns],
      }
    : {
        conversationId: input.conversationId,
        cartCode: null,
        step: "need_code",
        signals: {},
        turns: [],
        lastInboundId: null,
        signalSource: null,
        updatedAt: nowIso,
      };

  session.lastInboundId = input.messageId;
  session.updatedAt = nowIso;
  session.turns.push({ role: "shopper", text: input.text });

  const link = parseLinkCommand(input.text);
  if (/^link\b/i.test(input.text.trim()) && !link) {
    return say(session, "link <userId>");
  }
  const linkedUserId = linkedUserFrom(link, input.resolveLinkCode);
  if (link?.code && !linkedUserId) {
    return say(session, "link <userId>");
  }
  const phoneLink = link
    ? {
        userId: linkedUserId ?? threadUserId(input.conversationId),
        conversationId: input.conversationId,
        ...(input.agentSenderId ? { agentSenderId: input.agentSenderId } : {}),
        linkedAt: nowIso,
      }
    : undefined;
  if (link) {
    return say(session, "Linked. I'll text this thread the next time a checkout pauses.", {
      ...(phoneLink ? { phoneLink } : {}),
    });
  }

  const foundCode = extractCartCode(input.text, { allowBare: session.step === "need_code" || !session.cartCode });
  if (foundCode && foundCode !== session.cartCode) {
    session.cartCode = foundCode;
    session.signals = {};
    session.signalSource = null;
    session.step = "need_code";
  }
  if (!session.cartCode) {
    const resolved = input.resolveCart?.(input.conversationId);
    if (resolved) {
      session.cartCode = resolved.code;
    }
  }
  if (!session.cartCode) {
    return say(session, `I don't have your bag on this thread yet. Text the cart code, then answer: ${UPGRADE_PROMPT}`);
  }

  const loaded = input.loadCart(session.cartCode);
  if (!loaded) {
    const missing = session.cartCode;
    session.cartCode = null;
    session.step = "need_code";
    return say(session, `I can't find cart ${missing}. Open your Apple bag so Simmer can read it, then text that code.`);
  }

  const cart: Cart = { ...loaded, signals: { ...loaded.signals }, items: loaded.items.map((item) => ({ ...item })) };
  cart.conversationId = input.conversationId;
  if (input.agentSenderId) {
    cart.agentSenderId = input.agentSenderId;
  }
  cart.lastInboundMessageId = input.messageId;

  return justifyTurn(session, cart, input);
}

async function justifyTurn(session: Session, cart: Cart, input: ApplyInput): Promise<ApplyResult> {
  await fillDecision(session, cart, input);
  session.step = "confirm";
  if (cart.necessity === "necessary") {
    return say(session, "This bag is a necessary buy. Checkout can proceed. Simmer will not click the button.", { cart });
  }
  const spoken = withoutCartLabel(input.text) || input.text.trim();
  const useGrok = Boolean(input.extract?.apiKey);
  if (useGrok) {
    cart.reading = true;
    input.markReading?.(cart);
  }
  let graded;
  try {
    graded = await gradeJustification(spoken, input.extract ?? {});
  } finally {
    if (useGrok) {
      cart.reading = false;
    }
  }
  if (spoken && graded.grade !== 0) {
    const impulse = cart.userImpulseScore ?? personaFor(cart.userId).impulseScore;
    applyPurchaseScore(cart, graded, impulse, input.now, input.demoReminderMs);
  }
  holdForUnlock(cart);
  syncFreeBandCopy(cart);
  const advice = adviceMessage(glanceFromCart(cart));
  cart.advice = advice;
  cart.replied = false;
  return say(session, advice, { cart, markReplied: true, disarmReminder: true });
}

async function fillDecision(session: Session, cart: Cart, input: ApplyInput): Promise<void> {
  const context: ConversationContext = {
    step: session.step,
    signals: session.signals,
    turns: session.turns.slice(0, -1),
  };
  const useGrok = Boolean(input.extract?.apiKey);
  if (useGrok) {
    cart.reading = true;
    input.markReading?.(cart);
  }
  let extraction;
  try {
    extraction = await extractSignals(input.text, context, input.extract ?? {});
  } finally {
    if (useGrok) {
      cart.reading = false;
    }
  }
  session.signalSource = extraction.source;
  session.signals = mergeSignals(session.signals, pickShopperSignals(extraction.signals));
  const signals = withCartFacts(session.signals, cart.totalCents);
  const decision = decide(signals);
  cart.signalSource = extraction.source;
  cart.motiveSources = extraction.motiveSources;
  cart.signals = signals;
  cart.decision = decision;
  cart.explanation = phraseDecision(decision, signals, extraction.source, extraction.motiveSources);
  session.signals = signals;
}

function glanceFromCart(cart: Cart): GlanceItem {
  return {
    code: cart.code,
    name: cart.items[0]?.name ?? "Apple bag",
    priceCents: cart.totalCents,
    status: cart.status === "vault" || cart.status === "unlocked" ? cart.status : "locked",
    vaultUntil: cart.vaultUntil,
    decision: cart.decision,
    signals: cart.signals,
    motiveSources: cart.motiveSources,
    necessity: cart.necessity,
    necessitySource: cart.necessitySource,
    necessityReason: cart.necessityReason,
    userImpulseScore: cart.userImpulseScore,
    justificationGrade: cart.justificationGrade,
    gradeSource: cart.gradeSource,
    gradeReason: cart.gradeReason,
    purchaseScore: cart.purchaseScore,
    scoreBucket: cart.scoreBucket,
    scoreReason: cart.scoreReason,
  };
}

function linkedUserFrom(
  link: { userId: string | null; code: string | null } | null,
  resolveLinkCode: ((code: string) => string | null) | undefined,
): string | null {
  if (!link) {
    return null;
  }
  if (link.code) {
    const resolved = resolveLinkCode?.(link.code) ?? null;
    return resolved && resolved.trim().length > 0 ? resolved : null;
  }
  return link.userId;
}

function withoutCartLabel(text: string): string {
  return text.replace(/\bcart\s+[A-HJ-NP-Z2-9]{6}\b/gi, " ").replace(/\s+/g, " ").trim();
}

function mergeSignals(base: Session["signals"], patch: Session["signals"]): Session["signals"] {
  return {
    ...base,
    ...patch,
    problems: patch.problems ?? base.problems,
  };
}

function say(
  session: Session,
  reply: string,
  extra: { cart?: Cart; armReminder?: boolean; disarmReminder?: boolean; markReplied?: boolean; phoneLink?: PhoneLink } = {},
): ApplyResult {
  session.turns.push({ role: "agent", text: reply });
  session.updatedAt = new Date().toISOString();
  return {
    session,
    reply,
    duplicate: false,
    armReminder: extra.armReminder === true,
    disarmReminder: extra.disarmReminder === true,
    markReplied: extra.markReplied === true,
    ...(extra.cart ? { cart: extra.cart } : {}),
    ...(extra.phoneLink ? { phoneLink: extra.phoneLink } : {}),
  };
}
