export type InboundMessage = {
  id: string;
  conversationId: string;
  text: string;
  agentSenderId?: string;
  /** Mongo _id from a verified session. Demo and Photon messages leave this unset. */
  authUserId?: string;
};

export type OutboundMessage = {
  conversationId: string;
  text: string;
  agentSenderId?: string;
  parentMessageId?: string;
  idempotencyKey: string;
};
