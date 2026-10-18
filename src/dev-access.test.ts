import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { demoReplyOpen, devRoutesOpen, manualUnlockOpen } from "./dev-access.js";

describe("dev access", () => {
  it("opens dev routes outside production and locks unlock unless the flag is set", () => {
    assert.equal(devRoutesOpen({ NODE_ENV: "test" }), true);
    assert.equal(manualUnlockOpen({ NODE_ENV: "test" }), false);
    assert.equal(manualUnlockOpen({ NODE_ENV: "test", WAITMATE_DEV_UNLOCK: "1" }), true);
    assert.equal(devRoutesOpen({ NODE_ENV: "production" }), false);
    assert.equal(devRoutesOpen({ NODE_ENV: "production", WAITMATE_DEV_UNLOCK: "1" }), true);
    assert.equal(manualUnlockOpen({ NODE_ENV: "production", WAITMATE_DEV_UNLOCK: "1" }), false);
    assert.equal(demoReplyOpen({ NODE_ENV: "test" }), false);
    assert.equal(demoReplyOpen({ NODE_ENV: "test", WAITMATE_DEMO: "1" }), true);
    assert.equal(demoReplyOpen({ NODE_ENV: "production", WAITMATE_DEMO: "1" }), false);
  });
});
