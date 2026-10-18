import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readIncomingMessage } from "./handle-message.js";

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

describe("readIncomingMessage", () => {
  it("keeps the shopper text for a human iMessage", () => {
    const decision = readIncomingMessage(event(), config);
    assert.equal(decision.action, "receive");
    if (decision.action !== "receive") {
      return;
    }
    assert.equal(decision.message.text, "need shoes");
    assert.equal(decision.message.agentSenderId, "pho_usr_00000000000000000000000002");
    assert.equal(decision.message.spaceId, "pho_spc_00000000000000000000000000");
  });

  it("ignores the guessed shape where data itself is the message", () => {
    const decision = readIncomingMessage(
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
    assert.equal(readIncomingMessage(typing, config).action, "ignore");

    const otherLine = event();
    const otherRecord = otherLine as { data: { object: { receivedBy: { handle: string } } } };
    otherRecord.data.object.receivedBy.handle = "+15559990000";
    assert.deepEqual(readIncomingMessage(otherLine, config), { action: "ignore", reason: "not-our-agent" });

    const group = event();
    const groupRecord = group as { data: { object: { space: { kind: string } } } };
    groupRecord.data.object.space.kind = "group";
    assert.deepEqual(readIncomingMessage(group, config), { action: "ignore", reason: "not-direct" });

    const agent = event();
    const agentRecord = agent as { data: { object: { sentBy: { kind: string } } } };
    agentRecord.data.object.sentBy.kind = "agent";
    assert.deepEqual(readIncomingMessage(agent, config), { action: "ignore", reason: "not-human" });

    const ownLine = event();
    const ownRecord = ownLine as { data: { object: { sentBy: { handle: string } } } };
    ownRecord.data.object.sentBy.handle = "+15550001111";
    assert.deepEqual(readIncomingMessage(ownLine, config), { action: "ignore", reason: "not-human" });
  });
});
