import { releaseExpiredLock } from "./carts.js";
import type { OutboundMessage } from "./channel.js";
import { formatLongDate } from "./format.js";
import type { Store } from "./store.js";
import type { Cart } from "./types.js";

const MAX_TIMEOUT_MS = 2_147_000_000;

export function reminderCopy(cart: Cart, origin: string): string {
  const name = cart.items[0]?.name ?? "your bag";
  const until = cart.vaultUntil ? formatLongDate(cart.vaultUntil) : "the saved date";
  return `Simmer here. Cart ${cart.code} (${name}) stays paused until ${until}. Your Apple bag stays marinating.`;
}

export class ReminderScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private inflight = new Set<string>();

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
    if (!cart.reminderFireAt || cart.reminderSentAt || cart.status === "unlocked") {
      return;
    }
    const delay = new Date(cart.reminderFireAt).getTime() - this.deps.now().getTime();
    if (delay <= 0) {
      void this.fire(cart.code);
      return;
    }
    const wait = Math.min(delay, MAX_TIMEOUT_MS);
    const timer = later(() => {
      this.timers.delete(cart.code);
      const fresh = this.deps.store.getCart(cart.code);
      if (!fresh?.reminderFireAt || fresh.reminderSentAt || fresh.status === "unlocked") {
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
    if (this.inflight.has(code)) {
      return;
    }
    this.inflight.add(code);
    try {
      const cart = this.deps.store.getCart(code);
      if (!cart?.reminderFireAt || cart.reminderSentAt) {
        return;
      }
      if (cart.status === "unlocked" && cart.unlockReason !== "timer") {
        return;
      }
      if (cart.necessity === "necessary") {
        cart.reminderSentAt = this.deps.now().toISOString();
        this.deps.store.saveCart(cart);
        return;
      }
      if (cart.status !== "unlocked") {
        releaseExpiredLock(cart, this.deps.now());
        this.deps.store.saveCart(cart);
      }
      if (!cart.conversationId) {
        const opened = this.deps.store.getCart(code) ?? cart;
        if (!opened.reminderSentAt) {
          opened.reminderSentAt = this.deps.now().toISOString();
          this.deps.store.saveCart(opened);
        }
        return;
      }
      const text = reminderCopy(cart, this.deps.origin);
      const idempotencyKey = `simmer:reminder:${cart.code}:${cart.reminderFireAt}`;
      try {
        await this.deps.send({
          conversationId: cart.conversationId,
          text,
          agentSenderId: cart.agentSenderId ?? undefined,
          parentMessageId: cart.lastInboundMessageId ?? undefined,
          idempotencyKey,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Reminder failed.");
        const retry = later(() => {
          this.timers.delete(code);
          void this.fire(code);
        }, 5_000);
        this.timers.set(code, retry);
        return;
      }
      const sentAt = this.deps.now().toISOString();
      const fresh = this.deps.store.getCart(code) ?? cart;
      if (fresh.reminderSentAt || fresh.reminderFireAt !== cart.reminderFireAt) {
        return;
      }
      fresh.reminderSentAt = sentAt;
      this.deps.store.saveCart(fresh);
      const session = this.deps.store.getSession(cart.conversationId);
      if (session) {
        session.turns.push({ role: "agent", text });
        session.updatedAt = sentAt;
        this.deps.store.saveSession(session);
      }
    } finally {
      this.inflight.delete(code);
    }
  }
}

function later(run: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return timer;
}
