import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { connectMongo, mongoConfigured, mongoState, mongoUnavailableMessage } from "./db.js";

describe("Mongo connection guard", () => {
  it("treats a missing URI as not configured and does not connect", async () => {
    assert.equal(mongoConfigured(null), false);
    assert.equal(mongoConfigured("  "), false);
    assert.equal(mongoConfigured("mongodb+srv://user:pass@cluster.example.mongodb.net/simmer"), true);
    const next = await connectMongo(null);
    assert.equal(next, "not-configured");
    assert.equal(mongoState(), "not-configured");
    assert.equal(mongoUnavailableMessage(), "MongoDB is not configured.");
  });
});
