import type { InboundMessage, OutboundMessage } from "./channel.js";
import { applyTurn } from "./conversation.js";
import type { ExtractOptions } from "./extract-signals.js";
import type { Store } from "./store.js";
import type { Cart, Decision } from "./types.js";

export type Runtime = {
  enqueue(message: InboundMessage): Promise<void>;
};

export function createRuntime(deps: {
  store: Store;
  now: () => Date;
  demoReminderMs: number;
  send: (message: OutboundMessage) => Promise<void>;
  armReminder: (cart: Cart) => void;
  disarmReminder: (code: string) => void;
  polish: (template: string, action: Decision["action"]) => Promise<string>;
  extract?: ExtractOptions;
}): Runtime {
  const queues = new Map<string, Promise<void>>();

  async function processMessage(message: InboundMessage): Promise<void> {
    const result = await applyTurn({
      session: deps.store.getSession(message.conversationId) ?? null,
      conversationId: message.conversationId,
      messageId: message.id,
      text: message.text,
      ...(message.agentSenderId ? { agentSenderId: message.agentSenderId } : {}),
      now: deps.now(),
      demoReminderMs: deps.demoReminderMs,
      loadCart: (code) => deps.store.getCart(code),
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
    if (action && (reply.startsWith("Buy") || reply.startsWith("Wait") || reply.startsWith("Better"))) {
      reply = await deps.polish(reply, action);
      const last = result.session.turns.at(-1);
      if (last?.role === "agent") {
        last.text = reply;
      }
    }

    await deps.send({
      conversationId: message.conversationId,
      text: reply,
      agentSenderId: result.cart?.agentSenderId ?? message.agentSenderId,
      parentMessageId: message.id,
      idempotencyKey: `waitmate:${message.id}`,
    });
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
