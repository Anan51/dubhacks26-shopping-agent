import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { capItemName, ITEM_NAME_CAP, normalizeItemName } from "./item-name.js";

describe("posted item names", () => {
  it("drops the screen-reader suffix and collapses whitespace before the cap", () => {
    const real = "Noise-cancelling headphones ".repeat(5).trim();
    assert.ok(real.length <= ITEM_NAME_CAP);
    assert.ok(`${real} Opens in a new tab.`.length > ITEM_NAME_CAP);
    assert.equal(capItemName(`  ${real}   Opens in a new tab.  `), real);
    assert.equal(normalizeItemName("Phone   case\nOpens in a new tab"), "Phone case");
  });

  it("still caps a cleaned name that is longer than 140 characters", () => {
    assert.equal(capItemName("B".repeat(180)), "B".repeat(ITEM_NAME_CAP));
    assert.equal(capItemName("B".repeat(ITEM_NAME_CAP)), "B".repeat(ITEM_NAME_CAP));
  });
});
