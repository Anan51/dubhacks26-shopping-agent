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

export type CartStatus = "cooling" | "saved" | "completed";

export type Cart = {
  code: string;
  items: CartItem[];
  createdAt: string;
  status: CartStatus;
  coolingOffEndsAt: string;
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
  orderId: string | null;
  completedAt: string | null;
  /** Cooldown that was selected when this cart was created. */
  coolingMs: number;
  /** Due-today threshold, in cents, that was selected when this cart was created. */
  lockThresholdCents: number;
  /** Whether the WaitMate guard was on when this cart was created. */
  guardEnabled: boolean;
  /** Set when the shopper uses Buy anyway. Chat unlock leaves this empty. */
  buyAnywayAt: string | null;
  /** Which parser produced the shopper signals used for the verdict. */
  signalSource: SignalSource | null;
  /** Set when the shopper switches the cart to a synthetic alternative. */
  selectedAlternativeId: string | null;
  /** True while Grok is reading the latest shopper message for this cart. */
  reading: boolean;
};

export type ReasonCode =
  | "unusable-phone"
  | "over-budget"
  | "young-and-working"
  | "upside-down"
  | "waiting-saves-money"
  | "old-and-failing"
  | "default-wait"
  | "better-option";

/**
 * Buy or wait for now. Add `{ action: "better"; alternativeId: string }`
 * when a synthetic alternative should be the third call. Switches on `action`
 * use `assertNever`, so that variant will fail the build until it is handled.
 */
export type Verdict =
  | { action: "buy"; alternativeId: null }
  | { action: "wait"; alternativeId: null }
  | { action: "better"; alternativeId: string };

export type Decision = Verdict & {
  reasons: ReasonCode[];
  horizonMonths: number;
  netNowCents: number;
  netLaterCents: number;
  tradeInNowCents: number;
  tradeInLaterCents: number;
  owedNowCents: number;
  owedLaterCents: number;
  paydownCents: number;
  tradeInDecayCents: number;
  upsideDownCents: number;
};

export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
