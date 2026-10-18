import type { InboundMessage } from "./channel.js";
import type { AgentConfig } from "./config.js";
import type { Runtime } from "./runtime.js";

/**
 * Public `message.received` event from the Beta OpenAPI schema
 * (`ImessageMessageReceivedEvent`). The message is `data.object`, not `data`.
 * Socket.IO `delivery` and the webhook POST carry this same object.
 * https://api.photon.codes/openapi.json
 * https://photon.codes/docs/beta/websocket/events
 */
export type HandleResult =
  | { action: "reply"; messageId: string }
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

export type ReceivedText = {
  id: string;
  text: string;
  spaceId: string;
  agentSenderId: string;
};

type EchoConfig = Pick<AgentConfig, "platform" | "agentHandle">;

export function readIncomingMessage(
  event: unknown,
  config: EchoConfig,
): { action: "receive"; message: ReceivedText } | { action: "ignore"; reason: IgnoreReason } {
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
  if (sentBy.kind !== "human" || sentBy.id === receivedBy.id || sentBy.handle === config.agentHandle) {
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
    action: "receive",
    message: { id: messageId, text, spaceId, agentSenderId: senderId },
  };
}

export async function handleIncomingEvent(event: unknown, runtime: Runtime, config: EchoConfig): Promise<HandleResult> {
  const parsed = readIncomingMessage(event, config);
  if (parsed.action === "ignore") {
    return parsed;
  }
  const inbound: InboundMessage = {
    id: parsed.message.id,
    conversationId: parsed.message.spaceId,
    text: parsed.message.text,
    agentSenderId: parsed.message.agentSenderId,
  };
  await runtime.enqueue(inbound);
  return { action: "reply", messageId: parsed.message.id };
}

function ignore(reason: IgnoreReason): { action: "ignore"; reason: IgnoreReason } {
  return { action: "ignore", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
