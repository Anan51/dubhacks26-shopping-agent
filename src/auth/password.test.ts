import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashPassword, isPasswordHash, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("stores an argon2 hash and never the plaintext password", async () => {
    const password = "correct horse battery";
    const passwordHash = await hashPassword(password);
    assert.notEqual(passwordHash, password);
    assert.equal(passwordHash.includes(password), false);
    assert.equal(passwordHash.startsWith("$argon2id$"), true);
    assert.equal(isPasswordHash(passwordHash), true);
    assert.equal(isPasswordHash(password), false);
    assert.equal(await verifyPassword(password, passwordHash), true);
    assert.equal(await verifyPassword("wrong horse battery", passwordHash), false);
    assert.equal(await verifyPassword(password, password), false);
  });
});
