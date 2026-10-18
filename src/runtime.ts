import type { InboundMessage, OutboundMessage } from "./channel.js";
import { applyTurn } from "./conversation.js";
import type { ExtractOptions } from "./extract-signals.js";
import { cartForThread } from "./phone-link.js";
import type { Store } from "./store.js";
import type { Cart, Decision } from "./types.js";

export type Runtime = {
  enqueue(message: InboundMessage): Promise<void>;
};

export function createRuntime(deps: {
  store: Store;
  now: () => Date;
  demoReminderMs: number;
  send: (message: OutboundMessage) => Promise<void | { ok: boolean }>;
  armReminder: (cart: Cart) => void;
  disarmReminder: (code: string) => void;
  polish: (template: string, action: Decision["action"]) => Promise<string>;
  /** Set only when Backboard is configured. Called with the Mongo user id, never a cart id. */
  personalizeNudge?: (text: string, authenticatedUserId: string) => Promise<string>;
  extract?: ExtractOptions;
}): Runtime {
  const queues = new Map<string, Promise<void>>();

  async function processMessage(message: InboundMessage): Promise<void> {
    if (deps.store.hasHandledInbound(message.id)) {
      return;
    }
    // Claim the id before any await so a replay cannot send a second reply.
    deps.store.rememberInbound(message.id);
    const prior = deps.store.getSession(message.conversationId);
    const priorTurnCount = prior?.turns.length ?? 0;
    const priorLastInboundId = prior?.lastInboundId ?? null;
    try {
      await handleInbound(message);
    } catch (error) {
      deps.store.forgetInbound(message.id);
      const session = deps.store.getSession(message.conversationId);
      if (session?.lastInboundId === message.id) {
        session.turns = session.turns.slice(0, priorTurnCount);
        session.lastInboundId = priorLastInboundId;
        deps.store.saveSession(session);
      }
      throw error;
    }
  }

  async function handleInbound(message: InboundMessage): Promise<void> {
    const result = await applyTurn({
      session: deps.store.getSession(message.conversationId) ?? null,
      conversationId: message.conversationId,
      messageId: message.id,
      text: message.text,
      ...(message.agentSenderId ? { agentSenderId: message.agentSenderId } : {}),
      now: deps.now(),
      demoReminderMs: deps.demoReminderMs,
      loadCart: (code) => deps.store.getCart(code),
      resolveCart: (conversationId) => {
        const link = deps.store.findPhoneLinkByConversation(conversationId);
        return cartForThread(deps.store.listCarts(), conversationId, link?.userId ?? null);
      },
      ...(deps.extract ? { extract: deps.extract } : {}),
      markReading: (readingCart) => {
        deps.store.saveCart(readingCart);
      },
    });
    if (result.duplicate || !result.reply) {
      return;
    }

    let reply = result.reply;
    const action = result.cart?.decision?.action;
    if (result.phoneLink) {
      deps.store.savePhoneLink(result.phoneLink);
    }
    if (action && (reply.startsWith("Waiting") || reply.startsWith("Unlock"))) {
      reply = await deps.polish(reply, action);
      const last = result.session.turns.at(-1);
      if (last?.role === "agent") {
        last.text = reply;
      }
    }
    if (deps.personalizeNudge && message.authUserId && result.cart?.explanation) {
      const before = result.cart.explanation;
      const personalized = await deps.personalizeNudge(before, message.authUserId);
      if (personalized !== before && reply.includes(before)) {
        reply = reply.replace(before, personalized);
        result.cart.explanation = personalized;
        const last = result.session.turns.at(-1);
        if (last?.role === "agent") {
          last.text = reply;
        }
      }
    }

    deps.store.saveSession(result.session);
    if (result.cart) {
      deps.store.saveCart(result.cart);
      if (result.armReminder) {
        deps.armReminder(result.cart);
      }
      if (result.disarmReminder) {
        deps.disarmReminder(result.cart.code);
      }
    }
    let delivered = false;
    try {
      const outcome = await deps.send({
        conversationId: message.conversationId,
        text: reply,
        agentSenderId: result.cart?.agentSenderId ?? message.agentSenderId,
        parentMessageId: message.id,
        idempotencyKey: `simmer:${message.id}`,
      });
      delivered = !sendFailed(outcome);
      if (!delivered) {
        logSendFailure(undefined);
      }
    } catch (error) {
      console.error((error as any)?.status, (error as any)?.message, (error as any)?.rawBody);
      logSendFailure(error);
      delivered = false;
    }
    if (!delivered) {
      throw new Error("iMessage send failed.");
    }
    if (result.markReplied && result.cart) {
      result.cart.replied = true;
      deps.store.saveCart(result.cart);
    }
  }

  return {
    enqueue(message) {
      const previous = queues.get(message.conversationId) ?? Promise.resolve();
      const next = previous.then(() => processMessage(message));
      queues.set(
        message.conversationId,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
  };
}

function sendFailed(outcome: void | { ok: boolean }): boolean {
  return typeof outcome === "object" && outcome !== null && outcome.ok === false;
}

/** Log the failure without the reply text, phone numbers, or API keys. */
function logSendFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : "Error";
  console.error(`iMessage send failed (${name}).`);
}
