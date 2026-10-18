import { mountOverlay, type OverlayActions, type OverlayModel } from "./overlay.js";

const model: OverlayModel = {
  code: "AB23CD",
  status: "locked",
  isUnlocked: false,
  lockEndsAt: new Date(Date.now() + 600_000).toISOString(),
  vaultUntil: null,
  totalCents: 4_201,
  parsedFromPage: true,
  itemNames: ["60W USB-C Charge Cable (1 m)"],
  quantity: 2,
  explanation: null,
  decision: null,
  signals: {},
  motiveSources: null,
  reading: false,
  userId: "user-demo1",
  linkMessage: null,
  fallbackPage: false,
  replied: false,
  advice: null,
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

const actions: OverlayActions = {
  unlock() {
    return undefined;
  },
  sleep() {
    return undefined;
  },
};

const css = document.getElementById("simmer-css")?.textContent ?? "";
const host = document.createElement("div");
host.id = "simmer-root";
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = css;
shadow.append(style);
mountOverlay(shadow, model, actions);
document.documentElement.append(host);
