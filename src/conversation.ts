import { isVaultActive, sleepCart, unlockCart, VAULT_MS, withCartFacts } from "./carts.js";
import { extractCartCode, extractSignals, pickShopperSignals, type ExtractOptions } from "./extract-signals.js";
import { formatLongDate } from "./format.js";
import { decide } from "./heuristic.js";
import { parseLinkCommand, threadUserId } from "./phone-link.js";
import { phraseDecision } from "./phrase.js";
import type { PhoneLink } from "./store.js";
import { assertNever, type Cart, type ConversationContext, type Session } from "./types.js";

export type ApplyInput = {
  session: Session | null;
  conversationId: string;
  messageId: string;
  text: string;
  agentSenderId?: string;
  now: Date;
  demoReminderMs: number;
  loadCart: (code: string) => Cart | undefined;
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
  phoneLink?: PhoneLink;
};

type Intent = "unlock" | "sleep" | null;

export async function applyTurn(input: ApplyInput): Promise<ApplyResult> {
  if (input.session?.lastInboundId === input.messageId) {
    return {
      session: input.session,
      reply: null,
      duplicate: true,
      armReminder: false,
      disarmReminder: false,
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
  const phoneLink = link
    ? {
        userId: link.userId ?? threadUserId(input.conversationId),
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
    return say(session, "Send the cart code from the Apple bag overlay, like: cart AB23CD.");
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

  const intent = readIntent(input.text);
  switch (intent) {
    case "unlock":
      return unlockTurn(session, cart, input.now);
    case "sleep":
      return sleepTurn(session, cart, input);
    case null:
      return justifyTurn(session, cart, input);
    default:
      return assertNever(intent);
  }
}

function unlockTurn(session: Session, cart: Cart, now: Date): ApplyResult {
  if (isVaultActive(cart, now)) {
    const until = cart.vaultUntil ? formatLongDate(cart.vaultUntil) : "the saved time";
    return say(session, `This bag keeps marinating in the Vault until ${until}. Unlock stays on the overlay and waits until then.`, { cart });
  }
  unlockCart(cart);
  session.step = "confirm";
  return say(session, "Unlock — Apple's own button works again. Simmer will not click it or place the order.", {
    cart,
    disarmReminder: true,
  });
}

async function sleepTurn(session: Session, cart: Cart, input: ApplyInput): Promise<ApplyResult> {
  await fillDecision(session, cart, input);
  sleepCart(cart, input.now, VAULT_MS, input.demoReminderMs);
  session.step = "confirm";
  const until = cart.vaultUntil ? formatLongDate(cart.vaultUntil) : "tomorrow";
  const lead = cart.explanation ?? "Sleep on it.";
  return say(session, `${lead}\n\nYour Apple bag is covered in the Vault until ${until}. Unlock stays available there.`, {
    cart,
    armReminder: true,
  });
}

async function justifyTurn(session: Session, cart: Cart, input: ApplyInput): Promise<ApplyResult> {
  await fillDecision(session, cart, input);
  session.step = "confirm";
  const explanation = cart.explanation ?? "Tell me why you want this.";
  if (isVaultActive(cart, input.now) && cart.vaultUntil) {
    return say(session, `${explanation}\n\nThis bag stays covered in the Vault until ${formatLongDate(cart.vaultUntil)}.`, {
      cart,
    });
  }
  return say(session, explanation, { cart });
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

function readIntent(text: string): Intent {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (normalized === "unlock" || normalized === "i've decided" || normalized === "ive decided") {
    return "unlock";
  }
  if (normalized === "sleep" || normalized === "sleep on it" || normalized === "wait") {
    return "sleep";
  }
  return null;
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
  extra: { cart?: Cart; armReminder?: boolean; disarmReminder?: boolean; phoneLink?: PhoneLink } = {},
): ApplyResult {
  session.turns.push({ role: "agent", text: reply });
  session.updatedAt = new Date().toISOString();
  return {
    session,
    reply,
    duplicate: false,
    armReminder: extra.armReminder === true,
    disarmReminder: extra.disarmReminder === true,
    ...(extra.cart ? { cart: extra.cart } : {}),
    ...(extra.phoneLink ? { phoneLink: extra.phoneLink } : {}),
  };
}
