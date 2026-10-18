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

export type GuardSettings = {
  enabled: boolean;
  thresholdCents: number;
  coolingMs: number;
};

export type Alternative = {
  id: string;
  name: string;
  label: string;
  priceCents: number;
  solves: string[];
  reason: string;
};

export type Decision = {
  action: "buy" | "wait" | "better";
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
  lockThresholdCents: number;
  guardEnabled: boolean;
  buyAnywayAt: string | null;
  signalSource: "grok" | "keywords" | null;
  reading: boolean;
  selectedAlternativeId: string | null;
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
  guardDefaults: GuardSettings;
  cooldownChoicesMs: number[];
  demoReminderMs: number;
  demoDefault: boolean;
  grokEnabled: boolean;
};

export type TranscriptTurn = {
  role: "shopper" | "agent";
  text: string;
};

export async function getAlternatives(): Promise<Alternative[]> {
  const body = await request<{ alternatives: Alternative[] }>("/api/alternatives");
  return body.alternatives;
}

export async function switchCart(code: string, alternativeId: string): Promise<CartResponse> {
  return request<CartResponse>(`/api/carts/${code}/switch`, {
    method: "POST",
    body: JSON.stringify({ alternativeId }),
  });
}

export async function getCatalog(): Promise<Product[]> {
  const body = await request<{ products: Product[] }>("/api/catalog");
  return body.products;
}

export async function getConfig(): Promise<PublicConfig> {
  return request<PublicConfig>("/api/config");
}

export async function createCart(
  itemIds: string[],
  demo: boolean,
  sessionId: string,
  guard: GuardSettings,
): Promise<CartResponse> {
  return request<CartResponse>("/api/carts", {
    method: "POST",
    body: JSON.stringify({ itemIds, demo, sessionId, guard }),
  });
}

export async function getGuard(sessionId: string): Promise<{ settings: GuardSettings; cooldownChoicesMs: number[] }> {
  return request(`/api/guard?sessionId=${encodeURIComponent(sessionId)}`);
}

export async function saveGuard(sessionId: string, settings: GuardSettings): Promise<GuardSettings> {
  const body = await request<{ settings: GuardSettings }>("/api/guard", {
    method: "PUT",
    body: JSON.stringify({ sessionId, settings }),
  });
  return body.settings;
}

export async function buyAnyway(code: string): Promise<CartResponse> {
  return request<CartResponse>(`/api/carts/${code}/buy-anyway`, { method: "POST" });
}

export async function getCart(code: string): Promise<CartResponse> {
  return request<CartResponse>(`/api/carts/${code}`);
}

export async function getTranscript(conversationId: string): Promise<{ turns: TranscriptTurn[]; reading: boolean }> {
  return request<{ turns: TranscriptTurn[]; reading: boolean }>(
    `/api/dev/messages?conversationId=${encodeURIComponent(conversationId)}`,
  );
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
