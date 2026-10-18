/** Shopper fields are filled only by `extractSignals`. Cart prices are filled from the catalog. */
export type Condition = "fine" | "minor" | "broken" | "unusable";

export type ProblemTag = "battery" | "screen" | "performance" | "cost";

export type SignalSource = "grok" | "keywords";

export type Signals = {
  deviceAgeMonths: number;
  condition: Condition;
  /** Shopper's own words about the current phone. */
  problemText: string;
  /** Problems named in the shopper's words. Empty when they did not name one. */
  problems: ProblemTag[];
  owedCents: number;
  budgetCents: number;
  /** Phone plus accessories due today. Not a monthly plan. */
  dueTodayCents: number;
  phonePriceCents: number;
  monthlyPlanCents: number;
};

export type AskStep = "need_code" | "age" | "problem" | "owed" | "budget" | "confirm";

export type TranscriptTurn = {
  role: "shopper" | "agent";
  text: string;
};

/**
 * Prior turns plus the question we are waiting on.
 * The current shopper message is passed separately to `extractSignals`.
 */
export type ConversationContext = {
  step: AskStep;
  signals: Partial<Signals>;
  turns: readonly TranscriptTurn[];
};

export type Session = {
  conversationId: string;
  cartCode: string | null;
  step: AskStep;
  signals: Partial<Signals>;
  turns: TranscriptTurn[];
  lastInboundId: string | null;
  signalSource: SignalSource | null;
  updatedAt: string;
};

export type CatalogKind = "phone" | "plan" | "accessory";

export type CartItem = {
  id: string;
  kind: CatalogKind;
  name: string;
  detail: string;
  priceCents: number;
  cadence: "once" | "monthly";
};

export type CartStatus = "locked" | "vault" | "unlocked";

/** What the extension shows when the checkout ping cannot land in a linked thread. */
export type CheckoutPing = {
  delivered: boolean;
  reason: "unlinked" | "send_failed" | null;
  smsLink: string | null;
  qrDataUrl: string | null;
  prefilled: string;
};

export type Cart = {
  code: string;
  items: CartItem[];
  /** Bag total the heuristic treats as the price of buying now. */
  totalCents: number;
  /** False when the extension could not read the Apple bag and used the example phone. */
  parsedFromPage: boolean;
  pageHost: string | null;
  fingerprint: string;
  createdAt: string;
  status: CartStatus;
  demo: boolean;
  signals: Partial<Signals>;
  decision: Decision | null;
  explanation: string | null;
  reminderAt: string | null;
  reminderFireAt: string | null;
  reminderSentAt: string | null;
  conversationId: string | null;
  agentSenderId: string | null;
  lastInboundMessageId: string | null;
  /** Marinating. The extension keeps Apple's buttons blocked until this is true. */
  isUnlocked: boolean;
  lockStartedAt: string;
  lockEndsAt: string;
  /** When set and still in the future, the Apple bag and checkout stay in the Impulse Vault. */
  vaultUntil: string | null;
  /** Which parser produced the shopper signals used for the verdict. */
  signalSource: SignalSource | null;
  /** True while Grok is reading the latest shopper message for this cart. */
  reading: boolean;
  userId: string | null;
  lastPing: CheckoutPing | null;
};

/** Sleep on it, or end marinating. Switches on `action` use `assertNever`. */
export type VerdictAction = "sleep" | "unlock";

export type Decision = {
  action: VerdictAction;
  /** Month in 1..12 where waiting saves the most. 0 when buying now is cheaper. */
  waitMonths: number;
  savingsCents: number;
  costNowCents: number;
  costLaterCents: number;
  tradeInNowCents: number;
  tradeInLaterCents: number;
  financingNowCents: number;
  financingLaterCents: number;
  newDeviceCents: number;
  /** Example-data curve for the overlay graph. Month 0 is today. */
  tradeInCurve: { month: number; cents: number }[];
};

export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
