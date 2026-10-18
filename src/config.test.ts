import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { photonConfigured, readConfig } from "./config.js";

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
  });
});
