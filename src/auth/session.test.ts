import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readSession, signSession, tokenFromRequest } from "./session.js";

describe("JWT session", () => {
  it("round-trips the user id and email and reads a bearer token", async () => {
    const secret = "test-secret";
    const token = await signSession({ id: "64b1c0f0c0ffee0000000001", email: "ada@example.com" }, secret);
    const user = await readSession(token, secret);
    assert.deepEqual(user, { id: "64b1c0f0c0ffee0000000001", email: "ada@example.com" });
    assert.equal(await readSession(token, "other-secret"), null);

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
});
