import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { apiPathAllowed, apiRequestInit } from "../api-auth.mjs";

describe("extension api auth", () => {
  it("sends the stored simmer_token as a bearer and includes cookies", () => {
    const authed = apiRequestInit("POST", "jwt-from-popup", { cartCode: "AB23CD" });
    const headers = authed.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer jwt-from-popup");
    assert.equal(authed.credentials, "include");
    assert.equal(authed.method, "POST");
    assert.equal(authed.body, JSON.stringify({ cartCode: "AB23CD" }));

    const anonymous = apiRequestInit("GET", "", undefined);
    assert.equal("authorization" in (anonymous.headers as Record<string, string>), false);
    assert.equal(anonymous.credentials, "include");
    assert.equal(anonymous.body, undefined);

    assert.equal(apiPathAllowed("/api/carts"), true);
    assert.equal(apiPathAllowed("/purchases"), true);
    assert.equal(apiPathAllowed("/purchases/history"), true);
    assert.equal(apiPathAllowed("/auth/login"), false);
    assert.equal(apiPathAllowed("https://evil.example"), false);
  });

  it("wires that helper into the background fetch of simmer_token", () => {
    const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
      background?: { type?: string };
    };
    assert.match(background, /simmer_token/);
    assert.match(background, /apiRequestInit/);
    assert.equal(manifest.background?.type, "module");
  });
});
