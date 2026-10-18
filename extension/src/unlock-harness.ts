import { mountSimmerCard } from "./overlay/mount.js";
import type { OverlayModel } from "./overlay.js";
import type { StoreAdapter } from "./stores/adapter.js";

const model: OverlayModel = {
  code: "AB23CD",
  status: "locked",
  isUnlocked: false,
  lockEndsAt: new Date(Date.now() + 600_000).toISOString(),
  vaultUntil: null,
  totalCents: 1_900,
  parsedFromPage: true,
  itemNames: ["USB-C Charge Cable"],
  quantity: 1,
  explanation: null,
  decision: null,
  signals: {},
  motiveSources: null,
  reading: false,
  userId: "user-demo1",
  linkMessage: null,
  fallbackPage: false,
  replied: true,
  advice: "Wait on this one.",
  pingDelivered: true,
  pingReason: null,
  smsLink: null,
  qrDataUrl: null,
  turns: [],
  error: null,
  necessity: "unnecessary",
  necessitySource: "keywords",
  necessityReason: null,
  userImpulseScore: 2,
  justificationGrade: 2,
  gradeSource: "keywords",
  gradeReason: null,
  purchaseScore: 4,
  scoreBucket: "free",
  scoreReason: null,
};

const adapter: StoreAdapter = {
  id: "apple",
  match: () => true,
  readBag: () => null,
  checkoutButtons: () => [],
  isOrderConfirmation: () => false,
};

declare global {
  var __simmerUnlocks: number;
}

globalThis.__simmerUnlocks = 0;
const css = document.getElementById("simmer-css")?.textContent ?? "";
mountSimmerCard(adapter, document, css, model, {
  unlock() {
    globalThis.__simmerUnlocks += 1;
  },
  sleep() {
    return undefined;
  },
});
