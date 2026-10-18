import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { readAccountConfig } from "./config.js";

describe("JWT secret length", () => {
  it("leaves auth off when JWT_SECRET is unset", () => {
    assert.equal(readAccountConfig({}).jwtSecret, null);
    assert.equal(readAccountConfig({ JWT_SECRET: "" }).jwtSecret, null);
    assert.equal(readAccountConfig({ JWT_SECRET: "   " }).jwtSecret, null);
    assert.equal(readAccountConfig({}).mongodbUri, null);
    assert.equal(readAccountConfig({}).backboardEnabled, false);
  });

  it("throws when JWT_SECRET is set but shorter than 32 bytes", () => {
    const thirtyOneBytes = `${"é".repeat(15)}a`;
    assert.equal(Buffer.byteLength("placeholder"), 11);
    assert.equal(Buffer.byteLength("a".repeat(31)), 31);
    assert.equal(Buffer.byteLength(thirtyOneBytes), 31);
    for (const secret of ["placeholder", "a".repeat(31), thirtyOneBytes]) {
      assert.throws(() => readAccountConfig({ JWT_SECRET: secret }), /JWT_SECRET must be at least 32 bytes/);
    }
  });

  it("accepts a JWT_SECRET of at least 32 bytes", () => {
    const ascii = "a".repeat(32);
    const multibyte = "é".repeat(16);
    assert.equal(Buffer.byteLength(ascii), 32);
    assert.equal(Buffer.byteLength(multibyte), 32);
    assert.equal(multibyte.length < 32, true);
    assert.equal(readAccountConfig({ JWT_SECRET: ascii }).jwtSecret, ascii);
    assert.equal(readAccountConfig({ JWT_SECRET: multibyte }).jwtSecret, multibyte);
    assert.equal(readAccountConfig({ JWT_SECRET: `  ${"b".repeat(40)}  ` }).jwtSecret, "b".repeat(40));
  });
});
