import { Photon } from "@photon-ai/api";

import type { OutboundMessage } from "./channel.js";
import type { AgentConfig } from "./config.js";

export async function sendPhotonMessage(config: AgentConfig, message: OutboundMessage): Promise<void> {
  if (!message.agentSenderId) {
    throw new Error("Photon send needs the agent sender id from the inbound message.");
  }
  const photon = new Photon({
    baseUrl: config.apiOrigin,
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  await photon.projects.sendMessage({
    path: { id: config.projectId },
    headers: { "idempotency-key": message.idempotencyKey },
    body: {
      spaceId: message.conversationId,
      senderId: message.agentSenderId,
      ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
      content: { type: "text", format: "plain", text: message.text },
    },
  });
}
