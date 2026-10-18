export type CurvePoint = { month: number; cents: number };

export type Decision = {
  action: "sleep" | "unlock";
  mathAction: "sleep" | "unlock";
  mathWaitMonths: number;
  mathSavingsCents: number;
  signalEffect: "need_unlock" | "want_sleep" | "math";
  financingAction: "sleep" | "unlock";
  financingSavingsCents: number;
  offerId: string | null;
  offerName: string | null;
  offerSavingCents: number;
  offerMonthsFromNow: number;
  waitMonths: number;
  savingsCents: number;
  costNowCents: number;
  costLaterCents: number;
  tradeInNowCents: number;
  tradeInLaterCents: number;
  financingNowCents: number;
  financingLaterCents: number;
  newDeviceCents: number;
  tradeInCurve: CurvePoint[];
};

export type CheckoutPing = {
  delivered: boolean;
  reason: "unlinked" | "send_failed" | null;
  smsLink: string | null;
  qrDataUrl: string | null;
  prefilled: string;
};

export type CartResponse = {
  code: string;
  items: { name: string; detail: string; priceCents: number }[];
  totalCents: number;
  parsedFromPage: boolean;
  pageHost: string | null;
  status: "locked" | "vault" | "unlocked";
  isUnlocked: boolean;
  lockEndsAt: string;
  vaultUntil: string | null;
  userId: string | null;
  signalSource: "grok" | "keywords" | null;
  reading: boolean;
  signals: {
    deviceAgeMonths?: number;
    condition?: string;
    problemText?: string;
    needVsWant?: "need" | "want" | "unknown";
    urgency?: "low" | "medium" | "high";
    currentPhoneBroken?: boolean;
    reasonText?: string;
    owedCents?: number;
    problems?: string[];
  };
  motiveSources: {
    needVsWant: "grok" | "keywords" | "default";
    urgency: "grok" | "keywords" | "default";
    currentPhoneBroken: "grok" | "keywords" | "default";
    reasonText: "grok" | "keywords" | "default";
  } | null;
  decision: Decision | null;
  explanation: string | null;
  necessity: "necessary" | "unnecessary" | null;
  necessitySource: "grok" | "keywords" | null;
  necessityReason: string | null;
  personaId: "impulsive" | "deliberate" | null;
  userImpulseScore: number | null;
  justificationGrade: number | null;
  gradeSource: "grok" | "keywords" | null;
  gradeReason: string | null;
  purchaseScore: number | null;
  scoreBucket: "free" | "soft" | "strict" | null;
  scoreReason: string | null;
  lastPing: CheckoutPing | null;
  smsLink: string;
  linkMessage: string | null;
  linkSmsLink: string | null;
  deskPath: string;
  textMessage: string;
  synthetic: true;
};

export type PublicConfig = {
  channel: "photon" | "stub";
  agentHandle: string | null;
  lockMs: number;
  demoReminderMs: number;
  grokEnabled: boolean;
  exampleOwedCents: number;
  fallbackTotalCents: number;
  exampleOffers: { id: string; name: string; savingCents: number; monthsFromNow: number; windowLabel: string }[];
  personas: {
    id: "impulsive" | "deliberate";
    label: string;
    userId: string;
    impulseScore: number;
    history: { item: string; cents: number; waited: boolean; note: string }[];
  }[];
};

export type PayGate = {
  ok: boolean;
  httpStatus: number;
  isUnlocked: boolean;
  reason: "locked" | "vault" | null;
  vaultUntil: string | null;
  code?: string;
};

export type TranscriptTurn = {
  role: "shopper" | "agent";
  text: string;
};

export async function getConfig(): Promise<PublicConfig> {
  return request<PublicConfig>("/api/config");
}

export async function listCarts(): Promise<CartResponse[]> {
  const body = await request<{ carts: CartResponse[] }>("/api/carts");
  return body.carts;
}

export async function getCart(code: string): Promise<CartResponse> {
  return request<CartResponse>(`/api/carts/${code}`);
}

export async function readPayGate(code: string): Promise<PayGate> {
  const response = await fetch("/api/pay", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return (await response.json()) as PayGate;
}

export async function setPersona(userId: string, persona: "impulsive" | "deliberate"): Promise<void> {
  await request("/api/dev/persona", {
    method: "POST",
    body: JSON.stringify({ userId, persona }),
  });
}

export async function linkDesk(userId: string, conversationId: string): Promise<void> {
  await request("/api/dev/link", {
    method: "POST",
    body: JSON.stringify({ userId, conversationId }),
  });
}

export async function notifyCart(code: string, fail: boolean): Promise<CartResponse> {
  return request<CartResponse>(`/api/carts/${code}/notify`, {
    method: "POST",
    body: JSON.stringify({ fail }),
  });
}

export async function getTranscript(conversationId: string): Promise<{ turns: TranscriptTurn[]; reading: boolean }> {
  return request(`/api/dev/messages?conversationId=${encodeURIComponent(conversationId)}`);
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
