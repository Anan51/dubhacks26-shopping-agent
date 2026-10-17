export type Kind = "phone" | "plan" | "accessory";

export type Product = {
  id: string;
  kind: Kind;
  name: string;
  detail: string;
  blurb: string;
  priceCents: number;
  cadence: "once" | "monthly";
};

export type LineItem = {
  id: string;
  kind: Kind;
  name: string;
  detail: string;
  priceCents: number;
  cadence: "once" | "monthly";
};

export type Decision = {
  action: "buy" | "wait";
  alternativeId: string | null;
  horizonMonths: number;
  netNowCents: number;
  netLaterCents: number;
  tradeInNowCents: number;
  tradeInLaterCents: number;
  owedNowCents: number;
  owedLaterCents: number;
  upsideDownCents: number;
};

export type CartResponse = {
  code: string;
  items: LineItem[];
  status: "cooling" | "saved" | "completed";
  createdAt: string;
  coolingOffEndsAt: string;
  coolingMs: number;
  lockThresholdCents: number | null;
  demo: boolean;
  decision: Decision | null;
  explanation: string | null;
  reminderAt: string | null;
  orderId: string | null;
  completedAt: string | null;
  textMessage: string;
  smsLink: string | null;
  deskPath: string;
  synthetic: true;
};

export type PublicConfig = {
  channel: "photon" | "stub";
  agentHandle: string | null;
  coolingMs: number;
  lockThresholdCents: number | null;
  demoReminderMs: number;
  demoDefault: boolean;
};

export type TranscriptTurn = {
  role: "shopper" | "agent";
  text: string;
};

export async function getCatalog(): Promise<Product[]> {
  const body = await request<{ products: Product[] }>("/api/catalog");
  return body.products;
}

export async function getConfig(): Promise<PublicConfig> {
  return request<PublicConfig>("/api/config");
}

export async function createCart(itemIds: string[], demo: boolean): Promise<CartResponse> {
  return request<CartResponse>("/api/carts", {
    method: "POST",
    body: JSON.stringify({ itemIds, demo }),
  });
}

export async function getCart(code: string): Promise<CartResponse> {
  return request<CartResponse>(`/api/carts/${code}`);
}

export async function getTranscript(conversationId: string): Promise<TranscriptTurn[]> {
  const body = await request<{ turns: TranscriptTurn[] }>(
    `/api/dev/messages?conversationId=${encodeURIComponent(conversationId)}`,
  );
  return body.turns;
}

export async function sendDeskMessage(conversationId: string, text: string): Promise<TranscriptTurn[]> {
  const body = await request<{ turns: TranscriptTurn[] }>("/api/dev/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId, text }),
  });
  return body.turns;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return body;
}
