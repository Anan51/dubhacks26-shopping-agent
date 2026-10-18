export type InboundMessage = {
  id: string;
  conversationId: string;
  text: string;
  agentSenderId?: string;
};

export type OutboundMessage = {
  conversationId: string;
  text: string;
  agentSenderId?: string;
  parentMessageId?: string;
  idempotencyKey: string;
};
