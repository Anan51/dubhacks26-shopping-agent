import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { capItemName, cartItemLines, ITEM_NAME_CAP, normalizeItemName, postedItemNames, POSTED_ITEM_LIMIT } from "./item-name.js";

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

  it("posts every distinct title up to the cap, after cleanup", () => {
    const names = postedItemNames([
      "  Notebook   Opens in a new tab.  ",
      "Notebook",
      "Pencil",
      "B".repeat(180),
      "Ruler",
      "Eraser",
      "Clip",
    ]);
    assert.equal(POSTED_ITEM_LIMIT, 5);
    assert.deepEqual(names, ["Notebook", "Pencil", "B".repeat(ITEM_NAME_CAP), "Ruler", "Eraser"]);
    assert.equal(names.includes("Clip"), false);
    assert.equal(names.some((name) => name.length > ITEM_NAME_CAP), false);
  });

  it("lists the first titles and counts the rest", () => {
    assert.deepEqual(cartItemLines(["Notebook", "Pencil"]), { shown: ["Notebook", "Pencil"], more: 0 });
    assert.deepEqual(cartItemLines(["A", "B", "C", "D", "E", "F", "A"]), {
      shown: ["A", "B", "C", "D", "E"],
      more: 1,
    });
  });
});
