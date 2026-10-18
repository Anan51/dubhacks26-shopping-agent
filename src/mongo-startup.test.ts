import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mongoConnectOptions, warnIfMongoWithoutJwt } from "./mongo-startup.js";

describe("mongo connect database name", () => {
  it("defaults to simmer when MONGODB_DB is unset, empty, or whitespace", () => {
    assert.deepEqual(mongoConnectOptions({}), { dbName: "simmer" });
    assert.deepEqual(mongoConnectOptions({ MONGODB_DB: "" }), { dbName: "simmer" });
    assert.deepEqual(mongoConnectOptions({ MONGODB_DB: "   " }), { dbName: "simmer" });
  });

  it("honors MONGODB_DB when set", () => {
    assert.deepEqual(mongoConnectOptions({ MONGODB_DB: "ledger" }), { dbName: "ledger" });
    assert.deepEqual(mongoConnectOptions({ MONGODB_DB: "  purchases  " }), { dbName: "purchases" });
  });
});

describe("mongo without JWT warning", () => {
  it("warns when MONGODB_URI is set and JWT_SECRET is not", () => {
    const warnings: string[] = [];
    warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/placeholder", jwtSecret: null }, (message) => {
      warnings.push(message);
    });
    assert.deepEqual(warnings, [
      "MONGODB_URI is set but JWT_SECRET is not. Signup will return 503 and the /purchases router will not be mounted.",
    ]);
  });

  it("uses console.warn by default and does not throw", () => {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args);
    }) as typeof console.warn;
    try {
      assert.doesNotThrow(() => {
        warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/placeholder", jwtSecret: null });
      });
    } finally {
      console.warn = original;
    }
    assert.deepEqual(warnings, [
      ["MONGODB_URI is set but JWT_SECRET is not. Signup will return 503 and the /purchases router will not be mounted."],
    ]);
  });

  it("stays quiet when JWT is set or Mongo is not configured", () => {
    const warnings: string[] = [];
    const warn = (message: string) => {
      warnings.push(message);
    };
    warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/placeholder", jwtSecret: "x".repeat(32) }, warn);
    warnIfMongoWithoutJwt({ mongodbUri: null, jwtSecret: null }, warn);
    warnIfMongoWithoutJwt({ mongodbUri: null, jwtSecret: "x".repeat(32) }, warn);
    assert.deepEqual(warnings, []);
  });
});
