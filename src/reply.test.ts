import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { replyToText } from "./reply.js";

describe("replyToText", () => {
  it("prefixes the inbound text", () => {
    assert.equal(
      replyToText("need running shoes"),
      "hello from the shopping agent: need running shoes",
    );
  });

  it("keeps the inbound text exactly, including surrounding spaces", () => {
    assert.equal(replyToText("  hi  "), "hello from the shopping agent:   hi  ");
  });
});
