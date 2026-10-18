import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Cart, Session } from "./types.js";

export type PhoneLink = {
  userId: string;
  conversationId: string;
  agentSenderId?: string;
  linkedAt: string;
};

/**
 * Carts, chat sessions, and linked phone threads.
 * Memory is the default. A JSON file store exists for restarts.
 * A MongoDB store can implement these methods later without changing callers.
 */
export type Store = {
  getCart(code: string): Cart | undefined;
  saveCart(cart: Cart): void;
  listCarts(): Cart[];
  getSession(conversationId: string): Session | undefined;
  saveSession(session: Session): void;
  getPhoneLink(userId: string): PhoneLink | undefined;
  savePhoneLink(link: PhoneLink): void;
};

type Snapshot = {
  carts: Record<string, Cart>;
  sessions: Record<string, Session>;
  phoneLinks: Record<string, PhoneLink>;
};

export function createMemoryStore(): Store {
  return new MemoryStore();
}

export function createFileStore(filePath: string): Store {
  return new FileStore(filePath);
}

export function createDefaultStore(filePath: string | null): Store {
  return filePath ? createFileStore(filePath) : createMemoryStore();
}

class MemoryStore implements Store {
  private carts = new Map<string, Cart>();
  private sessions = new Map<string, Session>();
  private phoneLinks = new Map<string, PhoneLink>();

  getCart(code: string): Cart | undefined {
    const cart = this.carts.get(code.toUpperCase());
    return cart ? clone(cart) : undefined;
  }

  saveCart(cart: Cart): void {
    this.carts.set(cart.code.toUpperCase(), clone(cart));
  }

  listCarts(): Cart[] {
    return [...this.carts.values()].map((cart) => clone(cart));
  }

  getSession(conversationId: string): Session | undefined {
    const session = this.sessions.get(conversationId);
    return session ? clone(session) : undefined;
  }

  saveSession(session: Session): void {
    this.sessions.set(session.conversationId, clone(session));
  }

  getPhoneLink(userId: string): PhoneLink | undefined {
    const link = this.phoneLinks.get(userId);
    return link ? clone(link) : undefined;
  }

  savePhoneLink(link: PhoneLink): void {
    this.phoneLinks.set(link.userId, clone(link));
  }
}

class FileStore implements Store {
  private snapshot: Snapshot = { carts: {}, sessions: {}, phoneLinks: {} };

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Snapshot;
      this.snapshot = {
        carts: parsed.carts ?? {},
        sessions: parsed.sessions ?? {},
        phoneLinks: parsed.phoneLinks ?? {},
      };
    } catch {
      this.snapshot = { carts: {}, sessions: {}, phoneLinks: {} };
    }
  }

  getCart(code: string): Cart | undefined {
    const cart = this.snapshot.carts[code.toUpperCase()];
    return cart ? clone(cart) : undefined;
  }

  saveCart(cart: Cart): void {
    this.snapshot.carts[cart.code.toUpperCase()] = clone(cart);
    this.persist();
  }

  listCarts(): Cart[] {
    return Object.values(this.snapshot.carts).map((cart) => clone(cart));
  }

  getSession(conversationId: string): Session | undefined {
    const session = this.snapshot.sessions[conversationId];
    return session ? clone(session) : undefined;
  }

  saveSession(session: Session): void {
    this.snapshot.sessions[session.conversationId] = clone(session);
    this.persist();
  }

  getPhoneLink(userId: string): PhoneLink | undefined {
    const link = this.snapshot.phoneLinks[userId];
    return link ? clone(link) : undefined;
  }

  savePhoneLink(link: PhoneLink): void {
    this.snapshot.phoneLinks[link.userId] = clone(link);
    this.persist();
  }

  private persist(): void {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.snapshot));
    renameSync(temporary, this.filePath);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
