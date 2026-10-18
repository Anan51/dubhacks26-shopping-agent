import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { User } from "./user.js";

describe("User schema", () => {
  it("keeps email unique and lowercased, requires a password hash, and has no Google fields", async () => {
    const email = User.schema.path("email");
    const passwordHash = User.schema.path("passwordHash");
    const assistant = User.schema.path("backboardAssistantId");
    assert.equal(email.options.unique, true);
    assert.equal(email.options.lowercase, true);
    assert.equal(passwordHash.isRequired, true);
    assert.equal(assistant.options.unique, true);
    assert.equal(assistant.options.sparse, true);
    assert.equal(User.schema.path("googleId"), undefined);
    assert.equal(User.schema.path("provider"), undefined);
    assert.equal(User.schema.path("password"), undefined);
    assert.equal(User.schema.options.timestamps, true);

    const hashed = new User({
      email: "Ada@Example.com",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    });
    await hashed.validate();
    assert.equal(hashed.email, "ada@example.com");

    const plaintext = new User({ email: "ada@example.com", passwordHash: "correct horse battery" });
    await assert.rejects(() => plaintext.validate(), (error: unknown) => {
      assert.ok(error instanceof Error);
      const details = error as Error & { errors?: { passwordHash?: { message?: string } } };
      assert.equal(details.errors?.passwordHash?.message, "passwordHash must be an argon2 or bcrypt hash.");
      return true;
    });
  });
});
