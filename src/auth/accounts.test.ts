import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logIn, publicUser, signUp, type AccountDirectory, type AccountUser } from "./accounts.js";

describe("email signup", () => {
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
    await signUp(directory, { email: "ada@example.com", password: "correct horse battery" });
    await logIn(directory, { email: "missing@example.com", password: "warmup-password" }).catch(() => undefined);

    const wrongMs = await medianElapsed(() =>
      logIn(directory, { email: "ada@example.com", password: "wrong horse battery" }).catch(() => undefined),
    );
    const unknownMs = await medianElapsed(() =>
      logIn(directory, { email: "missing@example.com", password: "wrong horse battery" }).catch(() => undefined),
    );
    assert.ok(unknownMs > wrongMs * 0.5, `unknown ${unknownMs}ms, wrong password ${wrongMs}ms`);
  });
});

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

async function medianElapsed(run: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    samples.push(await elapsed(run));
  }
  samples.sort((left, right) => left - right);
  return samples[1] ?? 0;
}

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
