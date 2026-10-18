import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextPurchaseFeedback } from "../../extension/src/purchase-feedback.js";

describe("purchase history popup", () => {
  it("clears an active vote and switches the other way", () => {
    assert.equal(nextPurchaseFeedback(null, "kept"), "kept");
    assert.equal(nextPurchaseFeedback("kept", "kept"), null);
    assert.equal(nextPurchaseFeedback("kept", "regretted"), "regretted");
    assert.equal(nextPurchaseFeedback("regretted", "regretted"), null);
  });
});