import type { OutboundMessage } from "./channel.js";
import { formatLongDate } from "./format.js";
import { deskChatUrl } from "./links.js";
import type { Store } from "./store.js";
import type { Cart } from "./types.js";

const MAX_TIMEOUT_MS = 2_147_000_000;

export function reminderCopy(cart: Cart, origin: string): string {
  const name = cart.items[0]?.name ?? "your bag";
  const until = cart.vaultUntil ? formatLongDate(cart.vaultUntil) : "the saved date";
  return `Simmer here. Cart ${cart.code} (${name}) stays covered in the Vault until ${until}. Your Apple bag stays marinating. Desk: ${origin.replace(/\/$/, "")}${deskChatUrl(cart.code)}`;
}

export class ReminderScheduler {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: {
      store: Store;
      origin: string;
      now: () => Date;
      send: (message: OutboundMessage) => Promise<void>;
    },
  ) {}

  arm(cart: Cart): void {
    this.disarm(cart.code);
    if (!cart.reminderFireAt || cart.reminderSentAt || cart.status === "unlocked" || !cart.conversationId) {
      return;
    }
    const delay = new Date(cart.reminderFireAt).getTime() - this.deps.now().getTime();
    if (delay <= 0) {
      void this.fire(cart.code);
      return;
    }
    const wait = Math.min(delay, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      this.timers.delete(cart.code);
      const fresh = this.deps.store.getCart(cart.code);
      if (!fresh?.reminderFireAt || fresh.reminderSentAt) {
        return;
      }
      const remaining = new Date(fresh.reminderFireAt).getTime() - this.deps.now().getTime();
      if (remaining > 250) {
        this.arm(fresh);
        return;
      }
      void this.fire(fresh.code);
    }, wait);
    this.timers.set(cart.code, timer);
  }

  disarm(code: string): void {
    const timer = this.timers.get(code);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(code);
    }
  }

  armPending(): void {
    for (const cart of this.deps.store.listCarts()) {
      if (cart.reminderFireAt && !cart.reminderSentAt && cart.status !== "unlocked") {
        this.arm(cart);
      }
    }
  }

  stop(): void {
    for (const code of this.timers.keys()) {
      this.disarm(code);
    }
  }

  private async fire(code: string): Promise<void> {
    const cart = this.deps.store.getCart(code);
    if (!cart?.reminderFireAt || cart.reminderSentAt || !cart.conversationId || cart.status === "unlocked") {
      return;
    }
    const text = reminderCopy(cart, this.deps.origin);
    try {
      await this.deps.send({
        conversationId: cart.conversationId,
        text,
        agentSenderId: cart.agentSenderId ?? undefined,
        parentMessageId: cart.lastInboundMessageId ?? undefined,
        idempotencyKey: `simmer:reminder:${cart.code}:${cart.reminderFireAt}`,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Reminder failed.");
      const retry = setTimeout(() => {
        this.timers.delete(code);
        void this.fire(code);
      }, 5_000);
      this.timers.set(code, retry);
      return;
    }

    const sentAt = this.deps.now().toISOString();
    this.deps.store.saveCart({ ...cart, reminderSentAt: sentAt });
    const session = this.deps.store.getSession(cart.conversationId);
    if (session) {
      session.turns.push({ role: "agent", text });
      session.updatedAt = sentAt;
      this.deps.store.saveSession(session);
    }
  }
}
