import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readAccountConfig, requireJwtSecret } from "./config.js";

describe("JWT secret length", () => {
  it("rejects a secret shorter than 32 bytes and accepts a longer one", () => {
    assert.throws(() => requireJwtSecret("too-short"), /at least 32 bytes/);
    assert.throws(() => readAccountConfig({ JWT_SECRET: "x".repeat(31) }), /at least 32 bytes/);
    const secret = "x".repeat(32);
    assert.equal(readAccountConfig({ JWT_SECRET: secret }).jwtSecret, secret);
    assert.equal(readAccountConfig({}).jwtSecret, null);
  });
});
