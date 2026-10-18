import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authOriginFromStorage } from "../extension/src/auth-flag.js";

describe("popup auth flag", () => {
  it("stays off unless a local auth server URL is set", () => {
    assert.equal(authOriginFromStorage(undefined), null);
    assert.equal(authOriginFromStorage(null), null);
    assert.equal(authOriginFromStorage(""), null);
    assert.equal(authOriginFromStorage("   "), null);
    assert.equal(authOriginFromStorage("https://127.0.0.1:4321"), null);
    assert.equal(authOriginFromStorage("http://evil.example"), null);
    assert.equal(authOriginFromStorage("not a url"), null);
    assert.equal(authOriginFromStorage("http://127.0.0.1:4321"), "http://127.0.0.1:4321");
    assert.equal(authOriginFromStorage("http://localhost:4321/auth"), "http://localhost:4321");
  });
});