import { Photon } from "@photon-ai/api";

import { readConfig, type AgentConfig } from "./config.js";
import { replyToText } from "./reply.js";

/**
 * Public `message.received` event from the Beta OpenAPI schema
 * (`ImessageMessageReceivedEvent`). The message is `data.object`, not `data`.
 * Socket.IO `delivery` and the webhook POST carry this same object.
 * https://api.photon.codes/openapi.json
 * https://photon.codes/docs/beta/websocket/events
 */
export type EchoDecision =
  | {
      action: "reply";
      messageId: string;
      spaceId: string;
      senderId: string;
      outboundText: string;
    }
  | { action: "ignore"; reason: IgnoreReason };

export type IgnoreReason =
  | "not-an-object"
  | "not-message-received"
  | "missing-message"
  | "wrong-platform"
  | "not-received"
  | "not-direct"
  | "not-human"
  | "not-our-agent"
  | "not-plain-text";

type EchoConfig = Pick<AgentConfig, "platform" | "agentHandle">;

export function decideEcho(event: unknown, config: EchoConfig): EchoDecision {
  if (!isRecord(event)) {
    return ignore("not-an-object");
  }
  if (event.type !== "message.received") {
    return ignore("not-message-received");
  }

  const data = isRecord(event.data) ? event.data : undefined;
  const message = data && isRecord(data.object) ? data.object : undefined;
  if (!message) {
    return ignore("missing-message");
  }
  if (message.platform !== config.platform || message.status !== "received") {
    return ignore(message.platform === config.platform ? "not-received" : "wrong-platform");
  }

  const space = isRecord(message.space) ? message.space : undefined;
  const sentBy = isRecord(message.sentBy) ? message.sentBy : undefined;
  const receivedBy = isRecord(message.receivedBy) ? message.receivedBy : undefined;
  const content = isRecord(message.content) ? message.content : undefined;
  if (!space || !sentBy || !receivedBy || !content) {
    return ignore("missing-message");
  }
  if (
    space.platform !== config.platform ||
    sentBy.platform !== config.platform ||
    receivedBy.platform !== config.platform
  ) {
    return ignore("wrong-platform");
  }
  if (config.platform === "imessage" && space.kind !== "direct") {
    return ignore("not-direct");
  }
  if (sentBy.kind !== "human" || sentBy.id === receivedBy.id) {
    return ignore("not-human");
  }
  if (receivedBy.kind !== "agent" || receivedBy.handle !== config.agentHandle) {
    return ignore("not-our-agent");
  }

  if (content.type !== "text" || content.format !== "plain") {
    return ignore("not-plain-text");
  }

  const messageId = stringField(message, "id");
  const spaceId = stringField(space, "id");
  const senderId = stringField(receivedBy, "id");
  const text = stringField(content, "text");
  if (!messageId || !spaceId || !senderId || text === undefined) {
    return ignore("missing-message");
  }

  return {
    action: "reply",
    messageId,
    spaceId,
    senderId,
    outboundText: replyToText(text),
  };
}

export async function handleIncomingEvent(event: unknown): Promise<EchoDecision> {
  const config = readConfig();
  const decision = decideEcho(event, config);
  switch (decision.action) {
    case "ignore":
      return decision;
    case "reply": {
      const photon = new Photon({
        baseUrl: config.apiOrigin,
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      await photon.projects.sendMessage({
        path: { id: config.projectId },
        headers: { "idempotency-key": `echo:${decision.messageId}` },
        body: {
          spaceId: decision.spaceId,
          senderId: decision.senderId,
          parentMessageId: decision.messageId,
          content: { type: "text", format: "plain", text: decision.outboundText },
        },
      });
      return decision;
    }
    default: {
      const unreachable: never = decision;
      return unreachable;
    }
  }
}

function ignore(reason: IgnoreReason): EchoDecision {
  return { action: "ignore", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
