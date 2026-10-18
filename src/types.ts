/** Shopper fields are filled only by `extractSignals`. Cart prices are filled from the catalog. */
export type Condition = "fine" | "minor" | "broken" | "unusable";

export type ProblemTag = "battery" | "screen" | "performance" | "cost";

export type SignalSource = "grok" | "keywords";

export type NeedVsWant = "need" | "want" | "unknown";

export type Urgency = "low" | "medium" | "high";

/** Where a motive field came from. Default means the shopper did not say. */
export type MotiveSource = SignalSource | "default";

export type MotiveSources = {
  needVsWant: MotiveSource;
  urgency: MotiveSource;
  currentPhoneBroken: MotiveSource;
  reasonText: MotiveSource;
};

export type Signals = {
  deviceAgeMonths: number;
  condition: Condition;
  /** Shopper's own words about the current phone. */
  problemText: string;
  /** Problems named in the shopper's words. Empty when they did not name one. */
  problems: ProblemTag[];
  /** Whether this purchase is a need, a want, or not stated. */
  needVsWant: NeedVsWant;
  urgency: Urgency;
  /** True when the shopper's current phone is broken or unusable. */
  currentPhoneBroken: boolean;
  /** Short reason taken from the shopper's words. */
  reasonText: string;
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

export type Necessity = "necessary" | "unnecessary";

/** `free` lifts the lock. `soft` offers sleep. `strict` requires the vault. */
export type ScoreBucket = "free" | "soft" | "strict";

export type VaultMode = "enforced" | "soft";

export type PersonaId = "impulsive" | "deliberate";

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
  /** Set when the countdown opens checkout. Absent on carts saved before this field. */
  unlockReason?: "timer" | null;
  /** True after Simmer has sent advice for an inbound reply. Unlock stays hidden until then. */
  replied: boolean;
  /** Buy, wait, or skip, plus one plain sentence. Null until a reply is graded. */
  advice: string | null;
  lockStartedAt: string;
  lockEndsAt: string;
  /** When set and still in the future, checkout stays paused until this time. */
  vaultUntil: string | null;
  /** Enforced vaults ignore Unlock. A soft vault is the optional pause. */
  vaultMode: VaultMode | null;
  /** Bag classification. Necessary buys are not locked. */
  necessity: Necessity | null;
  necessitySource: SignalSource | null;
  necessityReason: string | null;
  /** Mock history persona. Unknown shoppers use the impulsive seed. */
  personaId: PersonaId | null;
  /**
   * 1–5 base passed into the existing purchase-score math.
   * New carts take this from the 1–8 band (`legacyImpulseBase`), not from the Impulsive persona.
   * The dev persona switch can still overwrite it.
   */
  userImpulseScore: number | null;
  /** 1–8 impulsiveness. Null on carts saved before this field existed. */
  impulse?: {
    score1to8: number;
    band: ScoreBucket;
    why: string | null;
  } | null;
  /** Set only when the price is more than 8 hours at the shopper's rate. */
  hoursOfWork?: { hours: number; hourlyRate: number } | null;
  /** `This is about N hours of work at $R/hr.` or null when hours are hidden. */
  hoursOfWorkText?: string | null;
  /** -3..3. Null until the shopper replies. */
  justificationGrade: number | null;
  gradeSource: SignalSource | null;
  gradeReason: string | null;
  /** Impulse plus grade, clamped to 1–5. */
  purchaseScore: number | null;
  scoreBucket: ScoreBucket | null;
  /** One line for the popup. The grade's short reason. */
  scoreReason: string | null;
  /** Which parser produced the shopper signals used for the verdict. */
  signalSource: SignalSource | null;
  /** Per-field source for the motive signals that can move the verdict. */
  motiveSources: MotiveSources | null;
  /** True while Grok is reading the latest shopper message for this cart. */
  reading: boolean;
  userId: string | null;
  lastPing: CheckoutPing | null;
  /**
   * Plain carrier-switch sentence for the corner card.
   * Absent on Apple and Amazon carts. Not part of `Decision`.
   */
  carrierLine?: string | null;
};

/** Sleep on it, or end marinating. Switches on `action` use `assertNever`. */
export type VerdictAction = "sleep" | "unlock";

/** How the motive signals moved the price-math call. `math` means they did not. */
export type SignalEffect = "need_unlock" | "want_sleep" | "math";

export type Decision = {
  action: VerdictAction;
  /** What trade-in decay and financing alone would have said, before example offers. */
  financingAction: VerdictAction;
  financingSavingsCents: number;
  /** Money call after example offers. Motive signals can still override `action`. */
  mathAction: VerdictAction;
  mathWaitMonths: number;
  mathSavingsCents: number;
  /** Set when an example offer is the money reason to wait. Not a live carrier deal. */
  offerId: string | null;
  offerName: string | null;
  offerSavingCents: number;
  offerMonthsFromNow: number;
  /** Why `action` matches or leaves `mathAction`. */
  signalEffect: SignalEffect;
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
