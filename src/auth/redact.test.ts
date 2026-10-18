import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactMongoUri } from "./redact.js";

describe("redactMongoUri", () => {
  it("removes standard and srv URIs and leaves other text", () => {
    assert.equal(
      redactMongoUri("connect failed mongodb://user:secret-pass@127.0.0.1:27017/simmer after 10s"),
      "connect failed [redacted-mongodb-uri] after 10s",
    );
    assert.equal(
      redactMongoUri("mongodb+srv://user:secret-pass@cluster.example.mongodb.net/simmer?retryWrites=true"),
      "[redacted-mongodb-uri]",
    );
    assert.equal(
      redactMongoUri("a mongodb://one.example/db b mongodb+srv://two.example/db"),
      "a [redacted-mongodb-uri] b [redacted-mongodb-uri]",
    );
    assert.equal(redactMongoUri("MONGODB_URI is unset."), "MONGODB_URI is unset.");
  });
});