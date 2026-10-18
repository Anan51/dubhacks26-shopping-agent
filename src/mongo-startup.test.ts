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

  it("does not override a database name already in the URI", () => {
    assert.deepEqual(mongoConnectOptions({ MONGODB_URI: "mongodb://localhost/ledger" }), {});
    assert.deepEqual(
      mongoConnectOptions({
        MONGODB_URI: "mongodb+srv://user:pass@cluster.example.mongodb.net/simmer?retryWrites=true",
      }),
      {},
    );
    assert.deepEqual(
      mongoConnectOptions({
        MONGODB_URI: "mongodb://dbuser:dbpass@host1:27017,host2:27017/prod?replicaSet=rs0",
        MONGODB_DB: "   ",
      }),
      {},
    );
  });

  it("defaults to simmer when the URI has no database path", () => {
    assert.deepEqual(mongoConnectOptions({ MONGODB_URI: "mongodb://localhost" }), { dbName: "simmer" });
    assert.deepEqual(mongoConnectOptions({ MONGODB_URI: "mongodb://localhost/" }), { dbName: "simmer" });
    assert.deepEqual(
      mongoConnectOptions({ MONGODB_URI: "mongodb+srv://user:pass@cluster.example.mongodb.net/?retryWrites=true" }),
      { dbName: "simmer" },
    );
  });

  it("lets MONGODB_DB override a database name in the URI", () => {
    assert.deepEqual(
      mongoConnectOptions({ MONGODB_URI: "mongodb://localhost/ledger", MONGODB_DB: "purchases" }),
      { dbName: "purchases" },
    );
    assert.deepEqual(
      mongoConnectOptions({ MONGODB_URI: "mongodb://localhost/ledger", MONGODB_DB: "  archive  " }),
      { dbName: "archive" },
    );
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
    warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/placeholder", jwtSecret: "ab".repeat(16) }, warn);
    warnIfMongoWithoutJwt({ mongodbUri: null, jwtSecret: null }, warn);
    warnIfMongoWithoutJwt({ mongodbUri: null, jwtSecret: "ab".repeat(16) }, warn);
    assert.deepEqual(warnings, []);
  });

  it("warns when a long JWT_SECRET is an obvious placeholder and does not log it", () => {
    const warnings: string[] = [];
    const secrets = ["x".repeat(32), "changeme".repeat(4), "your-secret-here".repeat(2), "PLACEHOLDER".repeat(3)];
    for (const jwtSecret of secrets) {
      assert.doesNotThrow(() => {
        warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/simmer", jwtSecret }, (message) => {
          warnings.push(message);
        });
      });
    }
    assert.deepEqual(
      warnings,
      secrets.map(
        () => "JWT_SECRET is set to a placeholder or default value. Replace it with a long random secret. Startup will continue.",
      ),
    );
    for (const message of warnings) {
      for (const secret of secrets) {
        assert.equal(message.includes(secret), false);
      }
    }

    const quiet: string[] = [];
    const stayQuiet = (message: string) => {
      quiet.push(message);
    };
    warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/simmer", jwtSecret: "changeme" }, stayQuiet);
    warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/simmer", jwtSecret: "your-secret-here" }, stayQuiet);
    warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/simmer", jwtSecret: "placeholder" }, stayQuiet);
    warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/simmer", jwtSecret: "ab".repeat(16) }, stayQuiet);
    assert.deepEqual(quiet, []);

    const logged: unknown[][] = [];
    const original = console.warn;
    console.warn = ((...args: unknown[]) => {
      logged.push(args);
    }) as typeof console.warn;
    try {
      const secret = "y".repeat(40);
      assert.doesNotThrow(() => {
        warnIfMongoWithoutJwt({ mongodbUri: "mongodb://localhost/simmer", jwtSecret: secret });
      });
      assert.equal(JSON.stringify(logged).includes(secret), false);
    } finally {
      console.warn = original;
    }
    assert.deepEqual(logged, [
      ["JWT_SECRET is set to a placeholder or default value. Replace it with a long random secret. Startup will continue."],
    ]);
  });
});
