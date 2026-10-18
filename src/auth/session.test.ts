import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readSession, signSession, tokenFromRequest } from "./session.js";

describe("JWT session", () => {
  it("round-trips the user id and email and reads a bearer token", async () => {
    const secret = "test-secret".padEnd(32, "x");
    const token = await signSession({ id: "64b1c0f0c0ffee0000000001", email: "ada@example.com" }, secret);
    const user = await readSession(token, secret);
    assert.deepEqual(user, { id: "64b1c0f0c0ffee0000000001", email: "ada@example.com" });
    assert.equal(await readSession(token, "other-secret".padEnd(32, "y")), null);

    const req = {
      get(name: string) {
        if (name === "authorization") {
          return `Bearer ${token}`;
        }
        return undefined;
      },
    };
    assert.equal(tokenFromRequest(req as never), token);
  });

  it("refuses a secret shorter than 32 bytes", async () => {
    const user = { id: "64b1c0f0c0ffee0000000001", email: "ada@example.com" };
    const short = "a".repeat(31);
    const multibyte = "é".repeat(16);
    assert.equal(new TextEncoder().encode(short).byteLength, 31);
    assert.equal(multibyte.length < 32, true);
    assert.equal(new TextEncoder().encode(multibyte).byteLength, 32);
    await assert.rejects(() => signSession(user, short), /JWT_SECRET must be at least 32 bytes/);
    assert.equal(await readSession("not-a-jwt", short), null);
    const token = await signSession(user, multibyte);
    assert.deepEqual(await readSession(token, multibyte), user);
  });
});
