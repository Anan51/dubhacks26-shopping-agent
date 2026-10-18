import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import argon2 from "argon2";

import { logIn, publicUser, signUp, type AccountDirectory, type AccountUser } from "./accounts.js";
import { ARGON } from "./password.js";

describe("email signup", { concurrency: false }, () => {
  it("persists an argon2 hash and never the password", async () => {
    const saved: AccountUser[] = [];
    const directory = memoryDirectory(saved);
    const user = await signUp(directory, { email: "Ada@Example.com", password: "correct horse battery" });
    assert.equal(user.email, "ada@example.com");
    assert.notEqual(user.passwordHash, "correct horse battery");
    assert.equal(user.passwordHash.includes("correct horse battery"), false);
    assert.equal(user.passwordHash.startsWith("$argon2id$"), true);
    assert.equal(saved[0]?.passwordHash, user.passwordHash);
    assert.deepEqual(publicUser(user), { id: user.id, email: user.email });

    const loggedIn = await logIn(directory, { email: "ada@example.com", password: "correct horse battery" });
    assert.equal(loggedIn.id, user.id);
    await assert.rejects(
      () => logIn(directory, { email: "ada@example.com", password: "wrong horse battery" }),
      /Invalid email or password/,
    );
    await assert.rejects(
      () => logIn(directory, { email: "missing@example.com", password: "correct horse battery" }),
      /Invalid email or password/,
    );
  });

  it("spends a password verify when the email is unknown", async () => {
    const saved: AccountUser[] = [];
    const directory = memoryDirectory(saved);
    const user = await signUp(directory, { email: "ada@example.com", password: "correct horse battery" });
    const verify = mock.method(argon2, "verify");
    const hash = mock.method(argon2, "hash");
    try {
      await assert.rejects(
        () => logIn(directory, { email: "missing@example.com", password: "wrong horse battery" }),
        /Invalid email or password/,
      );
      await assert.rejects(
        () => logIn(directory, { email: "ada@example.com", password: "wrong horse battery" }),
        /Invalid email or password/,
      );
      assert.equal(hash.mock.calls.length, 0);
      assert.equal(verify.mock.calls.length, 2);
      const unknownCall = verify.mock.calls[0];
      const wrongCall = verify.mock.calls[1];
      assert.ok(unknownCall);
      assert.ok(wrongCall);
      const unknownHash = unknownCall.arguments[0];
      const wrongHash = wrongCall.arguments[0];
      const unknownAlgorithm = unknownHash.split("$")[1];
      const storedAlgorithm = user.passwordHash.split("$")[1];
      assert.equal(wrongHash, user.passwordHash);
      assert.ok(unknownAlgorithm);
      assert.equal(unknownAlgorithm, storedAlgorithm);
      assert.equal(argon2.needsRehash(unknownHash, ARGON), false);
      assert.equal(argon2.needsRehash(user.passwordHash, ARGON), false);
    } finally {
      verify.mock.restore();
      hash.mock.restore();
    }
  });
});

function memoryDirectory(saved: AccountUser[]): AccountDirectory {
  return {
    async findByEmail(email) {
      return saved.find((user) => user.email === email) ?? null;
    },
    async findById(id) {
      return saved.find((user) => user.id === id) ?? null;
    },
    async create(input) {
      const user: AccountUser = {
        id: `user-${saved.length + 1}`,
        email: input.email,
        passwordHash: input.passwordHash,
        backboardAssistantId: null,
      };
      saved.push(user);
      return user;
    },
    async setAssistantId(id, assistantId) {
      const user = saved.find((item) => item.id === id);
      if (user) {
        user.backboardAssistantId = assistantId;
      }
    },
  };
}
