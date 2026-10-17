import { withCartFacts } from "./carts.js";
import { extractCartCode, extractSignals, pickShopperSignals } from "./extract-signals.js";
import { addMonths, formatLongDate } from "./format.js";
import { decide } from "./heuristic.js";
import { phraseDecision } from "./phrase.js";
import {
  assertNever,
  type AskStep,
  type Cart,
  type ConversationContext,
  type Session,
  type Signals,
} from "./types.js";

export type ApplyInput = {
  session: Session | null;
  conversationId: string;
  messageId: string;
  text: string;
  agentSenderId?: string;
  now: Date;
  demoReminderMs: number;
  loadCart: (code: string) => Cart | undefined;
};

export type ApplyResult = {
  session: Session;
  cart?: Cart;
  reply: string | null;
  duplicate: boolean;
  armReminder: boolean;
  disarmReminder: boolean;
};

export function applyTurn(input: ApplyInput): ApplyResult {
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
        updatedAt: nowIso,
      };

  session.lastInboundId = input.messageId;
  session.updatedAt = nowIso;
  session.turns.push({ role: "shopper", text: input.text });

  const foundCode = extractCartCode(input.text, { allowBare: session.step === "need_code" || !session.cartCode });
  if (foundCode && foundCode !== session.cartCode) {
    session.cartCode = foundCode;
    session.signals = {};
    session.step = "need_code";
  }
  if (!session.cartCode) {
    return say(session, question("need_code"), { step: "need_code" });
  }

  const loaded = input.loadCart(session.cartCode);
  if (!loaded) {
    const missing = session.cartCode;
    session.cartCode = null;
    session.step = "need_code";
    return say(
      session,
      `I can't find cart ${missing}. Press Buy on the checkout page and text me that code.`,
    );
  }

  if (loaded.status === "completed") {
    return say(
      session,
      `Order ${loaded.orderId ?? "the mock order"} for cart ${loaded.code} already went through. No card was charged.`,
    );
  }

  const cart: Cart = { ...loaded, signals: { ...loaded.signals } };
  cart.conversationId = input.conversationId;
  if (input.agentSenderId) {
    cart.agentSenderId = input.agentSenderId;
  }
  cart.lastInboundMessageId = input.messageId;

  const context: ConversationContext = {
    step: session.step,
    signals: session.signals,
    turns: session.turns.slice(0, -1),
  };
  const patch = pickShopperSignals(extractSignals(input.text, context));
  const changed = signalsChanged(session.signals, patch);
  session.signals = mergeSignals(session.signals, patch);

  if (session.step === "confirm" && cart.decision && !changed) {
    return confirmTurn(session, cart, input);
  }

  const ask = nextAsk(session.signals);
  if (ask !== "ready") {
    const repeat = session.step === ask;
    session.step = ask;
    const reply = repeat ? `${hint(ask)} ${question(ask)}` : question(ask);
    return say(session, reply, { cart });
  }

  return decideTurn(session, cart, input);
}

function confirmTurn(session: Session, cart: Cart, input: ApplyInput): ApplyResult {
  const decision = cart.decision;
  if (!decision) {
    return decideTurn(session, cart, input);
  }
  const intent = readIntent(input.text);
  if (decision.action === "buy" && (intent === "yes" || intent === "buy")) {
    return completeCart(session, cart, input.now);
  }
  if (decision.action === "buy" && intent === "wait") {
    return saveWait(session, cart, input);
  }
  if (decision.action === "wait" && intent === "buy") {
    return completeCart(session, cart, input.now);
  }
  if (decision.action === "wait") {
    const when = cart.reminderAt ? formatLongDate(cart.reminderAt) : "the date I saved";
    return say(
      session,
      `Still holding cart ${cart.code}. I'll text you on ${when}. Reply BUY if you want checkout unlocked.`,
      { cart },
    );
  }
  return say(session, "Reply YES to unlock checkout, or WAIT to save the cart.", { cart });
}

function decideTurn(session: Session, cart: Cart, input: ApplyInput): ApplyResult {
  const signals = withCartFacts(session.signals, cart.items);
  const decision = decide(signals);
  const explanation = phraseDecision(decision, signals);
  cart.signals = signals;
  cart.decision = decision;
  cart.explanation = explanation;
  session.signals = signals;
  session.step = "confirm";

  if (decision.action === "wait") {
    return saveWait(session, cart, input);
  }

  cart.status = "cooling";
  cart.reminderAt = null;
  cart.reminderFireAt = null;
  cart.reminderSentAt = null;
  return say(session, `${explanation}\n\nReply YES to unlock checkout, or WAIT to save the cart.`, {
    cart,
    disarmReminder: true,
  });
}

function saveWait(session: Session, cart: Cart, input: ApplyInput): ApplyResult {
  const explanation = cart.explanation ?? "";
  const reminderAt = addMonths(input.now, cart.decision?.horizonMonths ?? 6);
  const fireAt = cart.demo ? new Date(input.now.getTime() + input.demoReminderMs) : reminderAt;
  cart.status = "saved";
  cart.reminderAt = reminderAt.toISOString();
  cart.reminderFireAt = fireAt.toISOString();
  cart.reminderSentAt = null;
  const when = formatLongDate(cart.reminderAt);
  const demoLine = cart.demo
    ? ` Demo mode is on, so I'll text you in about a minute instead of waiting until ${when}.`
    : "";
  return say(
    session,
    `${explanation}\n\nI saved cart ${cart.code}. I'll text you on ${when} with your checkout link.${demoLine} Reply BUY if you want it unlocked anyway.`,
    { cart, armReminder: true },
  );
}

function completeCart(session: Session, cart: Cart, now: Date): ApplyResult {
  cart.status = "completed";
  cart.orderId = `WM-${cart.code.slice(0, 4)}`;
  cart.completedAt = now.toISOString();
  cart.reminderFireAt = null;
  return say(
    session,
    `Checkout is unlocked. Order ${cart.orderId} is in for cart ${cart.code}. It's a mock receipt — no card was charged. The checkout page will update on its own.`,
    { cart, disarmReminder: true },
  );
}

function say(
  session: Session,
  reply: string,
  extra: { step?: AskStep; cart?: Cart; armReminder?: boolean; disarmReminder?: boolean } = {},
): ApplyResult {
  if (extra.step) {
    session.step = extra.step;
  }
  session.turns.push({ role: "agent", text: reply });
  return {
    session,
    cart: extra.cart,
    reply,
    duplicate: false,
    armReminder: extra.armReminder ?? false,
    disarmReminder: extra.disarmReminder ?? false,
  };
}

function nextAsk(signals: Partial<Signals>): AskStep | "ready" {
  if (signals.deviceAgeMonths === undefined) {
    return "age";
  }
  if (signals.condition === undefined) {
    return "problem";
  }
  if (signals.owedCents === undefined) {
    return "owed";
  }
  if (signals.budgetCents === undefined) {
    return "budget";
  }
  return "ready";
}

function question(step: AskStep): string {
  switch (step) {
    case "need_code":
      return "What's the cart code from checkout? It looks like K7MQ2P.";
    case "age":
      return "How old is the phone you have now? Months or years is fine — for example, 18 months or 2 years.";
    case "problem":
      return "What's wrong with it? For example: it works fine, the screen is cracked, or the battery dies by the afternoon.";
    case "owed":
      return "How much do you still owe on it, in dollars? Say 0 if it's paid off.";
    case "budget":
      return "What's the most you want to spend out of pocket today?";
    case "confirm":
      return "Reply YES to unlock checkout, or WAIT to save the cart.";
    default:
      return assertNever(step);
  }
}

function hint(step: AskStep): string {
  switch (step) {
    case "need_code":
      return "I still need the cart code.";
    case "age":
      return "I need an age, like 14 months or 2 years.";
    case "problem":
      return "Tell me if it's fine, scratched, cracked, the battery's going, or it won't turn on.";
    case "owed":
      return "Reply with a dollar amount, or 0.";
    case "budget":
      return "Reply with a dollar amount.";
    case "confirm":
      return "Reply YES or WAIT.";
    default:
      return assertNever(step);
  }
}

function readIntent(text: string): "yes" | "buy" | "wait" | null {
  const normalized = text.trim().toLowerCase();
  if (/\b(wait|hold off|not yet|save it)\b/.test(normalized) && !/\bbuy\b/.test(normalized)) {
    return "wait";
  }
  if (/^(no|nope)\b/.test(normalized)) {
    return "wait";
  }
  if (/\bbuy\b/.test(normalized)) {
    return "buy";
  }
  if (/^(yes|yep|yeah|y|confirm|unlock|do it|ok|okay)\b/.test(normalized)) {
    return "yes";
  }
  return null;
}

function mergeSignals(base: Partial<Signals>, patch: Partial<Signals>): Partial<Signals> {
  return { ...base, ...patch };
}

function signalsChanged(before: Partial<Signals>, patch: Partial<Signals>): boolean {
  const keys = ["deviceAgeMonths", "condition", "problemText", "owedCents", "budgetCents"] as const;
  return keys.some((key) => {
    const value = patch[key];
    return value !== undefined && value !== before[key];
  });
}
