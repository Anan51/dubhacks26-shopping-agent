import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { photonConfigured, readAppConfig, readConfig } from "./config.js";

const DEFAULT_STORE_PATH = "data/waitmate.json";

describe("Photon env", () => {
  it("reads the project id, line number, and API key from the environment", () => {
    const config = readConfig({
      PHOTON_API_KEY: "pho_sk_example",
      PHOTON_PROJECT_ID: "pho_prj_example",
      PHOTON_PLATFORM: "imessage",
      PHOTON_AGENT_HANDLE: "+15550001111",
    });
    assert.equal(config.apiKey, "pho_sk_example");
    assert.equal(config.projectId, "pho_prj_example");
    assert.equal(config.agentHandle, "+15550001111");
    assert.equal(config.platform, "imessage");
    assert.equal(
      photonConfigured({
        PHOTON_API_KEY: "pho_sk_example",
        PHOTON_PROJECT_ID: "pho_prj_example",
        PHOTON_PLATFORM: "imessage",
        PHOTON_AGENT_HANDLE: "+15550001111",
      }),
      true,
    );
    assert.equal(photonConfigured({}), false);
    assert.equal(readAppConfig({ PHOTON_TEST_NUMBER: "+15555550100" }).testNumber, "+15555550100");
    assert.equal(readAppConfig({}).testNumber, null);
  });
});

describe("store path", () => {
  it("defaults to data/waitmate.json and lets an explicit path override", () => {
    assert.equal(readAppConfig({}).storePath, DEFAULT_STORE_PATH);
    assert.equal(readAppConfig({ WAITMATE_STORE_PATH: "" }).storePath, DEFAULT_STORE_PATH);
    assert.equal(readAppConfig({ WAITMATE_STORE_PATH: "   " }).storePath, DEFAULT_STORE_PATH);
    assert.equal(readAppConfig({ WAITMATE_STORE_PATH: "tmp/carts.json" }).storePath, "tmp/carts.json");
  });

  it("stays in memory on Vercel unless WAITMATE_STORE_PATH is set", () => {
    assert.equal(readAppConfig({ VERCEL: "1" }).storePath, null);
    assert.equal(readAppConfig({ VERCEL: "1", WAITMATE_STORE_PATH: "" }).storePath, null);
    assert.equal(readAppConfig({ VERCEL: "1", WAITMATE_STORE_PATH: "   " }).storePath, null);
    assert.equal(readAppConfig({ VERCEL: "1", WAITMATE_STORE_PATH: "tmp/carts.json" }).storePath, "tmp/carts.json");
  });
});
