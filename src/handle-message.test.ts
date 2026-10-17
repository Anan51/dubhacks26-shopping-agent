import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideEcho } from "./handle-message.js";

const config = { platform: "imessage" as const, agentHandle: "+15550001111" };

function event(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "pho_evt_00000000000000000000000000",
    type: "message.received",
    apiVersion: "2026-07-01",
    source: "imessage.photon",
    timestamp: "2026-10-17T19:00:00.000Z",
    data: {
      projectId: "pho_prj_00000000000000000000000000",
      object: {
        id: "pho_msg_00000000000000000000000000",
        platform: "imessage",
        status: "received",
        space: { id: "pho_spc_00000000000000000000000000", platform: "imessage", kind: "direct" },
        sentBy: {
          id: "pho_usr_00000000000000000000000001",
          platform: "imessage",
          kind: "human",
          handle: "+15551112222",
        },
        receivedBy: {
          id: "pho_usr_00000000000000000000000002",
          platform: "imessage",
          kind: "agent",
          handle: "+15550001111",
        },
        content: { type: "text", format: "plain", text: "need shoes" },
      },
    },
    ...overrides,
  };
}

describe("decideEcho", () => {
  it("replies with the shared echo text for a human iMessage", () => {
    const decision = decideEcho(event(), config);
    assert.equal(decision.action, "reply");
    if (decision.action !== "reply") {
      return;
    }
    assert.equal(decision.outboundText, "hello from the shopping agent: need shoes");
    assert.equal(decision.senderId, "pho_usr_00000000000000000000000002");
    assert.equal(decision.spaceId, "pho_spc_00000000000000000000000000");
  });

  it("ignores the guessed shape where data itself is the message", () => {
    const decision = decideEcho(
      {
        id: "pho_evt_00000000000000000000000000",
        type: "message.received",
        data: {
          id: "pho_msg_00000000000000000000000000",
          platform: "imessage",
          status: "received",
          content: { type: "text", format: "plain", text: "need shoes" },
        },
      },
      config,
    );
    assert.deepEqual(decision, { action: "ignore", reason: "missing-message" });
  });

  it("ignores typing, other agents, and group chats", () => {
    const typing = event();
    const typingRecord = typing as { data: { object: { content: unknown } } };
    typingRecord.data.object.content = { type: "space.typing.update" };
    assert.equal(decideEcho(typing, config).action, "ignore");

    const otherLine = event();
    const otherRecord = otherLine as { data: { object: { receivedBy: { handle: string } } } };
    otherRecord.data.object.receivedBy.handle = "+15559990000";
    assert.deepEqual(decideEcho(otherLine, config), { action: "ignore", reason: "not-our-agent" });

    const group = event();
    const groupRecord = group as { data: { object: { space: { kind: string } } } };
    groupRecord.data.object.space.kind = "group";
    assert.deepEqual(decideEcho(group, config), { action: "ignore", reason: "not-direct" });
  });
});
