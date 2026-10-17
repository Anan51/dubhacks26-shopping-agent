import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Cart, Session } from "./types.js";

export type Store = {
  getCart(code: string): Cart | undefined;
  saveCart(cart: Cart): void;
  listCarts(): Cart[];
  getSession(conversationId: string): Session | undefined;
  saveSession(session: Session): void;
};

type Snapshot = {
  carts: Record<string, Cart>;
  sessions: Record<string, Session>;
};

export function createMemoryStore(): Store {
  return new MemoryStore();
}

export function createFileStore(filePath: string): Store {
  return new FileStore(filePath);
}

class MemoryStore implements Store {
  private carts = new Map<string, Cart>();
  private sessions = new Map<string, Session>();

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
}

class FileStore implements Store {
  private snapshot: Snapshot = { carts: {}, sessions: {} };

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Snapshot;
      this.snapshot = {
        carts: parsed.carts ?? {},
        sessions: parsed.sessions ?? {},
      };
    } catch {
      this.snapshot = { carts: {}, sessions: {} };
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

  private persist(): void {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.snapshot));
    renameSync(temporary, this.filePath);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
