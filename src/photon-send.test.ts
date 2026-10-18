import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import type { OutboundMessage } from "./channel.js";
import type { AgentConfig } from "./config.js";

type CapturedSend = {
  path: { id: string };
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const sent: CapturedSend[] = [];

const mockSource = `
export class Photon {
  constructor() {}
  projects = {
    sendMessage: async (input) => {
      globalThis.__photonSendRequests.push(input);
    },
  };
}
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "@photon-ai/api") {
      return nextResolve(specifier, context);
    }
    return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(mockSource)}`,
    };
  },
});

(globalThis as typeof globalThis & { __photonSendRequests: CapturedSend[] }).__photonSendRequests = sent;

const { sendPhotonMessage } = await import("./photon-send.js");

hooks.deregister();

const config: AgentConfig = {
  apiKey: "pho_sk_example",
  projectId: "pho_prj_example",
  platform: "imessage",
  agentHandle: "+15550001111",
  apiOrigin: "https://api.photon.codes",
};

describe("sendPhotonMessage", () => {
  it("sends a plain message body without parentMessageId", async () => {
    sent.length = 0;
    const message: OutboundMessage = {
      conversationId: "pho_spc_shared",
      text: "Buy.",
      agentSenderId: "pho_usr_agent",
      parentMessageId: "pho_msg_parent",
      idempotencyKey: "simmer:pho_msg_parent",
    };

    await sendPhotonMessage(config, message);

    assert.equal(sent.length, 1);
    const request = sent[0];
    assert.ok(request);
    assert.equal(Object.hasOwn(request.body, "parentMessageId"), false);
    assert.equal(request.body.spaceId, message.conversationId);
    assert.equal(request.body.senderId, message.agentSenderId);
    assert.deepEqual(request.body.content, {
      type: "text",
      format: "plain",
      text: message.text,
    });
    assert.deepEqual(Object.keys(request.body).sort(), ["content", "senderId", "spaceId"]);
    assert.equal(request.headers["idempotency-key"], "simmer:pho_msg_parent");
    assert.deepEqual(request.path, { id: config.projectId });
  });
});
