import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverExtensionMessage, extensionContextAlive, type ExtensionRuntime } from "./extension-context.js";

describe("extension context", () => {
  it("treats a missing or throwing runtime id as a dead extension", () => {
    assert.equal(extensionContextAlive(undefined), false);
    assert.equal(extensionContextAlive({ id: "" }), false);
    assert.equal(extensionContextAlive({ id: "ext" }), true);
    const dead = {
      get id(): string {
        throw new Error("Extension context invalidated.");
      },
    };
    assert.equal(extensionContextAlive(dead), false);
  });

  it("swallows the invalidated sendMessage promise and asks the page to stop", async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => {
      rejections.push(error);
    };
    process.on("unhandledRejection", onRejection);
    let stopped = 0;
    let sent = 0;
    const runtime: ExtensionRuntime = {
      get id(): string {
        return "ext";
      },
      sendMessage() {
        sent += 1;
        return Promise.reject(new Error("Extension context invalidated."));
      },
    };
    try {
      const result = await deliverExtensionMessage(runtime, { type: "simmer" }, () => {
        stopped += 1;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(result, null);
      assert.equal(stopped, 1);
      assert.equal(sent, 1);
      assert.equal(rejections.length, 0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("does not stop the page for an ordinary lastError", async () => {
    let stopped = 0;
    const runtime: ExtensionRuntime = {
      id: "ext",
      lastError: { message: "Could not establish connection. Receiving end does not exist." },
      sendMessage(_message, response) {
        response?.(null);
        return undefined;
      },
    };
    const result = await deliverExtensionMessage(runtime, { type: "simmer" }, () => {
      stopped += 1;
    });
    assert.equal(result, null);
    assert.equal(stopped, 0);
  });

  it("stops when the callback reports an invalidated context and still returns the body when alive", async () => {
    let stopped = 0;
    const dead: ExtensionRuntime = {
      id: "ext",
      lastError: { message: "Extension context invalidated." },
      sendMessage(_message, response) {
        response?.(undefined);
        return undefined;
      },
    };
    const missed = await deliverExtensionMessage(dead, { type: "simmer" }, () => {
      stopped += 1;
    });
    assert.equal(missed, null);
    assert.equal(stopped, 1);

    const alive: ExtensionRuntime = {
      id: "ext",
      sendMessage(_message, response) {
        response?.({ ok: true });
        return undefined;
      },
    };
    const body = await deliverExtensionMessage(alive, { type: "simmer" }, () => {
      stopped += 1;
    });
    assert.deepEqual(body, { ok: true });
    assert.equal(stopped, 1);
  });
});
