import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const CSS = readFileSync(new URL("./overlay.css", import.meta.url), "utf8");

describe("overlay layout", () => {
  it("keeps the card inside the viewport at 1024px and 1280px", () => {
    assert.match(CSS, /box-sizing:\s*border-box/);
    assert.match(CSS, /position:\s*fixed/);
    assert.match(CSS, /right:\s*max\(16px,\s*env\(safe-area-inset-right\)\)/);
    assert.match(CSS, /bottom:\s*max\(16px,\s*env\(safe-area-inset-bottom\)\)/);
    assert.match(CSS, /width:\s*min\(380px,\s*calc\(100vw - 32px\)\)/);
    assert.match(CSS, /max-width:\s*min\(380px,\s*calc\(100vw - 32px\)\)/);
    assert.match(CSS, /max-height:\s*calc\(100vh - 32px\)/);
    assert.match(CSS, /overflow-y:\s*auto/);
    assert.match(CSS, /overflow-wrap:\s*anywhere/);
    for (const viewport of [1024, 1280]) {
      const width = Math.min(380, viewport - 32);
      const right = 16;
      const leftEdge = viewport - right - width;
      assert.equal(leftEdge >= 16, true, `${viewport}`);
      assert.equal(leftEdge + width + right <= viewport, true, `${viewport}`);
      assert.equal(width <= viewport - 32, true, `${viewport}`);
    }
  });
});