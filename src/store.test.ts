import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { itemsForBag, startLockedCart } from "./carts.js";
import { readAppConfig } from "./config.js";
import { createDefaultStore, createFileStore } from "./store.js";

describe("file store reset", () => {
  it("clears carts, sessions, phone links, and inbound ids on disk", () => {
    const filePath = path.join(mkdtempSync(path.join(tmpdir(), "simmer-store-")), "store.json");
    const store = createFileStore(filePath);
    const now = new Date("2026-10-18T00:00:00.000Z");
    const cart = startLockedCart({
      items: itemsForBag(["iPhone 16 Pro"], 119_900, true),
      totalCents: 119_900,
      parsedFromPage: true,
      pageHost: "www.apple.com",
      fingerprint: "user-local|119900|iphone",
      now,
      demo: true,
      lockMs: 600_000,
      userId: "user-local",
      code: "AB23CD",
    });
    store.saveCart(cart);
    store.saveSession({
      conversationId: "desk:cart-AB23CD",
      cartCode: "AB23CD",
      step: "confirm",
      signals: {},
      turns: [{ role: "shopper", text: "hello" }],
      lastInboundId: "m1",
      signalSource: null,
      updatedAt: now.toISOString(),
    });
    store.savePhoneLink({ userId: "user-local", conversationId: "thread-1", linkedAt: now.toISOString() });
    const code = store.rememberLinkCode("user-local");
    store.rememberInbound("m1");
    const kept = createFileStore(filePath);
    assert.equal(kept.userIdForLinkCode(code), "user-local");
    store.reset();
    assert.equal(store.listCarts().length, 0);
    assert.equal(store.getSession("desk:cart-AB23CD"), undefined);
    assert.equal(store.getPhoneLink("user-local"), undefined);
    assert.equal(store.userIdForLinkCode(code), undefined);
    assert.equal(store.hasHandledInbound("m1"), false);
    const reloaded = createFileStore(filePath);
    assert.equal(reloaded.listCarts().length, 0);
    assert.equal(reloaded.getPhoneLink("user-local"), undefined);
    assert.equal(reloaded.userIdForLinkCode(code), undefined);
    assert.equal(reloaded.hasHandledInbound("m1"), false);
  });
});

describe("default store fallback", () => {
  it("keeps a writable file store", () => {
    const filePath = path.join(mkdtempSync(path.join(tmpdir(), "simmer-store-ok-")), "waitmate.json");
    const store = createDefaultStore(filePath);
    store.savePhoneLink({
      userId: "user-local",
      conversationId: "thread-1",
      linkedAt: "2026-10-18T00:00:00.000Z",
    });
    assert.equal(createDefaultStore(filePath).getPhoneLink("user-local")?.conversationId, "thread-1");
  });

  it("falls back to memory when the file store directory cannot be created", () => {
    const root = mkdtempSync(path.join(tmpdir(), "simmer-store-ro-"));
    const blocker = path.join(root, "not-a-directory");
    writeFileSync(blocker, "x");
    const filePath = path.join(blocker, "waitmate.json");
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args);
    }) as typeof console.warn;
    try {
      const store = createDefaultStore(filePath);
      store.savePhoneLink({
        userId: "user-local",
        conversationId: "thread-1",
        linkedAt: "2026-10-18T00:00:00.000Z",
      });
      assert.equal(store.getPhoneLink("user-local")?.conversationId, "thread-1");
      assert.equal(existsSync(filePath), false);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0]), /in-memory store/);
      assert.match(String(warnings[0]?.[0]), /not-a-directory/);
    } finally {
      console.warn = original;
    }
  });

  it("uses memory on Vercel when WAITMATE_STORE_PATH is unset", () => {
    const defaultFile = path.resolve("data/waitmate.json");
    const existed = existsSync(defaultFile);
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args);
    }) as typeof console.warn;
    try {
      const store = createDefaultStore(readAppConfig({ VERCEL: "1" }).storePath);
      store.savePhoneLink({
        userId: "user-local",
        conversationId: "thread-1",
        linkedAt: "2026-10-18T00:00:00.000Z",
      });
      assert.equal(store.getPhoneLink("user-local")?.conversationId, "thread-1");
      assert.equal(existsSync(defaultFile), existed);
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = original;
    }
  });
});
