import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { completeOrder, createCart } from "./carts.js";
import { itemsForIds } from "./catalog.js";
import {
  DEFAULT_GUARD_COOLING_MS,
  DEFAULT_GUARD_THRESHOLD_CENTS,
  defaultGuardSettings,
  parseGuardSettings,
  shouldLock,
} from "./guard.js";
import { createFileStore, createMemoryStore } from "./store.js";

const NOW = new Date("2026-10-17T20:00:00.000Z");

describe("shouldLock", () => {
  it("locks only when the guard is on and due today meets the threshold", () => {
    assert.equal(shouldLock({ enabled: true, dueTodayCents: 10_000, thresholdCents: 10_000 }), true);
    assert.equal(shouldLock({ enabled: true, dueTodayCents: 9_999, thresholdCents: 10_000 }), false);
    assert.equal(shouldLock({ enabled: false, dueTodayCents: 80_000, thresholdCents: 10_000 }), false);
  });
});

describe("guard settings", () => {
  it("defaults to on, $100, and 10 minutes", () => {
    assert.deepEqual(defaultGuardSettings(), {
      enabled: true,
      thresholdCents: DEFAULT_GUARD_THRESHOLD_CENTS,
      coolingMs: DEFAULT_GUARD_COOLING_MS,
    });
    assert.equal(DEFAULT_GUARD_THRESHOLD_CENTS, 10_000);
    assert.equal(DEFAULT_GUARD_COOLING_MS, 600_000);
  });

  it("accepts the cooldown choices and rejects anything else", () => {
    assert.equal("error" in parseGuardSettings({ enabled: true, thresholdCents: 0, coolingMs: 120_000 }), false);
    assert.equal("error" in parseGuardSettings({ enabled: true, thresholdCents: 0, coolingMs: 300_000 }), false);
    assert.equal("error" in parseGuardSettings({ enabled: true, thresholdCents: 0, coolingMs: 1_800_000 }), false);
    const rejected = parseGuardSettings({ enabled: true, thresholdCents: 0, coolingMs: 45_000 });
    assert.equal("error" in rejected, true);
  });

  it("keeps settings on the store for a session", () => {
    const memory = createMemoryStore();
    memory.saveGuard("guard:session-1", { enabled: false, thresholdCents: 25_000, coolingMs: 300_000 });
    assert.deepEqual(memory.getGuard("guard:session-1"), {
      enabled: false,
      thresholdCents: 25_000,
      coolingMs: 300_000,
    });

    const filePath = path.join(mkdtempSync(path.join(tmpdir(), "waitmate-")), "store.json");
    const file = createFileStore(filePath);
    file.saveGuard("guard:session-2", { enabled: true, thresholdCents: 10_000, coolingMs: 120_000 });
    const reopened = createFileStore(filePath);
    assert.deepEqual(reopened.getGuard("guard:session-2"), {
      enabled: true,
      thresholdCents: 10_000,
      coolingMs: 120_000,
    });
  });
});

describe("completeOrder", () => {
  it("logs Buy anyway and leaves a chat unlock unmarked", () => {
    const items = itemsForIds(["phone-lumen-mini"]);
    if (!items) {
      throw new Error("catalog missing");
    }
    const locked = createCart({
      items,
      now: NOW,
      demo: false,
      coolingMs: 120_000,
      lockThresholdCents: 10_000,
      guardEnabled: true,
      lock: true,
      code: "LOCK22",
    });
    const bypassed = completeOrder(locked, NOW, "buy-anyway");
    assert.equal(bypassed.status, "completed");
    assert.equal(bypassed.orderId, "WM-LOCK");
    assert.equal(bypassed.buyAnywayAt, NOW.toISOString());

    const again = completeOrder(bypassed, new Date(NOW.getTime() + 5_000), "buy-anyway");
    assert.equal(again.buyAnywayAt, NOW.toISOString());

    const chatCart = createCart({
      items,
      now: NOW,
      demo: false,
      coolingMs: 600_000,
      lockThresholdCents: 10_000,
      guardEnabled: true,
      lock: true,
      code: "CHAT22",
    });
    const chatted = completeOrder(chatCart, NOW, "chat");
    assert.equal(chatted.status, "completed");
    assert.equal(chatted.buyAnywayAt, null);
  });
});
