import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";

import { handleWebhook } from "../api/webhook.js";
import { currentCarts } from "./current-cart.js";
import { demoReplyOpen, devRoutesOpen, manualUnlockOpen } from "./dev-access.js";
import { offersSleep } from "./score-band.js";
import {
  bagFingerprint,
  FALLBACK_TOTAL_CENTS,
  isEnforcedVault,
  itemsForBag,
  lockState,
  scheduleCountdown,
  skipVault,
  sleepCart,
  startLockedCart,
  unlockCart,
  withCartFacts,
} from "./carts.js";
import type { AccountDirectory } from "./auth/accounts.js";
import { readAccountConfig } from "./auth/config.js";
import type { InboundMessage, OutboundMessage } from "./channel.js";
import type { PhotonChannel } from "./channels/photon.js";
import { demoCheckInsAllowed } from "./checkins/demo.js";
import { fireCheckInNow, takeCheckInReply } from "./checkins/service.js";
import { startCheckInLoop } from "./checkins/scheduler.js";
import { readConfig } from "./config.js";
import { handleIncomingEvent } from "./handle-message.js";
import { isPersonaId, PERSONAS, personaById, personaFor, type PersonaId } from "./history.js";
import { decide, EXAMPLE_OWED_CENTS } from "./heuristic.js";
import { applyPurchaseScore, classifyNecessity, keywordNecessity, syncFreeBandCopy } from "./impulse.js";
import { EXAMPLE_OFFERS } from "./offers.js";
import { deskChatUrl, linkPhoneSms, linkPhoneText, prefilledText, textSimmerLink } from "./links.js";
import { isUserId, notifyCheckout } from "./phone-link.js";
import type { BackboardClient } from "./memory/backboard.js";
import { phraseDecision, polishPhrase } from "./phrase.js";
import { ReminderScheduler } from "./reminders.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { applyImpulseReading, readingForCart } from "./scoring/cartReading.js";
import type { PhoneLink, Store } from "./store.js";
import type { Cart, Decision, Session } from "./types.js";

const DESK_ID = /^desk:[A-Za-z0-9:-]{8,80}$/;

export type AppDeps = {
  store: Store;
  origin: string;
  lockMs: number;
  demoReminderMs: number;
  demoDefault: boolean;
  agentHandle: string | null;
  photon: PhotonChannel | null;
  xaiApiKey?: string;
  xaiModel: string;
  xaiTimeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  polish?: (template: string, action: Decision["action"]) => Promise<string>;
  /** Test override. Request handlers read this instead of process.env when set. */
  env?: NodeJS.ProcessEnv;
  /**
   * Regret history moves the 1–8 score only when this is true.
   * Omitted follows BACKBOARD_API_KEY. Unset leaves the bag score unchanged.
   */
  backboardEnabled?: boolean;
  /** When set, a valid JWT cookie or bearer token fills req.user and does not block anonymous demo calls. */
  readSession?: (req: Request) => Promise<{ id: string; email: string } | null>;
  /**
   * Optional verdict personalization. Callers must pass the Mongo user id from req.user.
   * Omitted unless Backboard is configured, so demo copy stays the same.
   */
  personalizeNudge?: (text: string, authenticatedUserId: string) => Promise<string>;
  /** Present when Mongo is up. Check-in replies and the hourly sender use it. */
  checkIns?: {
    directory: AccountDirectory;
    client: BackboardClient;
    remote: boolean;
    intervalMs?: number;
  };
};

export type RunningApp = {
  app: express.Express;
  runtime: Runtime;
  scheduler: ReminderScheduler;
  stopCheckIns: () => void;
};

export function createApp(deps: AppDeps): RunningApp {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const backboardEnabled = deps.backboardEnabled ?? readAccountConfig(env).backboardEnabled;
  const assignedPersonas = new Map<string, PersonaId>();
  let bagReadError: string | null = null;
  const extractOptions = {
    ...(deps.xaiApiKey ? { apiKey: deps.xaiApiKey } : {}),
    model: deps.xaiModel,
    timeoutMs: deps.xaiTimeoutMs,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };

  function refineNecessity(code: string, bagText: string, authUserId?: string): void {
    void classifyNecessity(bagText, extractOptions)
      .then(async (necessity) => {
        if (necessity.source !== "grok") {
          return;
        }
        const current = deps.store.getCart(code);
        if (!current) {
          return;
        }
        applyNecessity(current, necessity);
        await attachImpulse(current, authUserId, "refresh");
        deps.store.saveCart(current);
      })
      .catch(() => undefined);
  }

  async function routeSend(message: OutboundMessage): Promise<void> {
    if (message.conversationId.startsWith("desk:")) {
      return;
    }
    if (!deps.photon) {
      throw new Error("Photon is not connected.");
    }
    await deps.photon.send(message);
  }

  const scheduler = new ReminderScheduler({
    store: deps.store,
    origin: deps.origin,
    now,
    send: (message) => routeSend(message),
  });
  const innerRuntime = createRuntime({
    store: deps.store,
    now,
    demoReminderMs: deps.demoReminderMs,
    send: (message) => routeSend(message),
    armReminder: (cart) => scheduler.arm(cart),
    disarmReminder: (code) => scheduler.disarm(code),
    polish:
      deps.polish ??
      ((template, action) => polishPhrase(template, action, deps.xaiApiKey, fetch, deps.xaiModel, deps.xaiTimeoutMs)),
    extract: extractOptions,
    ...(deps.personalizeNudge ? { personalizeNudge: deps.personalizeNudge } : {}),
  });
  const runtime: Runtime = {
    async enqueue(message) {
      if (await acceptCheckIn(message)) {
        deps.store.rememberInbound(message.id);
        return;
      }
      await innerRuntime.enqueue(message);
    },
  };
  let stopCheckIns = (): void => undefined;

  if (deps.photon) {
    deps.photon.onDelivery(async (event) => {
      const decision = await handleIncomingEvent(event, runtime, readConfig());
      if (decision.action === "ignore" && decision.reason !== "not-message-received") {
        console.log(`No reply (${decision.reason}).`);
      }
    });
  }

  const app = express();
  app.disable("x-powered-by");
  if (deps.readSession) {
    const readSession = deps.readSession;
    app.use((req, _res, next) => {
      readSession(req).then((user) => {
        if (user) {
          req.user = user;
        }
        next();
      }).catch(() => {
        next();
      });
    });
  }
  app.post("/api/webhook", (req, res) => {
    void handleWebhook(req, res, runtime);
  });
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, synthetic: true });
  });

  app.get("/fallback", (_req, res) => {
    res.type("html").send(readFileSync(path.join(process.cwd(), "web", "fallback.html"), "utf8"));
  });

  app.get("/fallback/cable", (_req, res) => {
    res.type("html").send(readFileSync(path.join(process.cwd(), "web", "fallback-cable.html"), "utf8"));
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      synthetic: true,
      channel: deps.photon ? "photon" : "stub",
      grokEnabled: Boolean(deps.xaiApiKey),
      agentHandle: deps.agentHandle,
      testNumber: env.PHOTON_TEST_NUMBER?.trim() || null,
      lockMs: deps.lockMs,
      demoReminderMs: deps.demoReminderMs,
      demoDefault: deps.demoDefault,
      exampleOwedCents: EXAMPLE_OWED_CENTS,
      fallbackTotalCents: FALLBACK_TOTAL_CENTS,
      exampleOffers: EXAMPLE_OFFERS,
      personas: PERSONAS,
      deskChat: true,
    });
  });

  app.get("/api/carts", (req, res) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : null;
    const carts = currentCarts(deps.store.listCarts(), userId);
    res.json({ synthetic: true, readError: bagReadError, carts: carts.map((cart) => publicCart(cart, deps.agentHandle)) });
  });

  app.post("/api/carts", settle(async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!isUserId(userId)) {
      res.status(400).json({ error: "userId must be 4–80 letters, numbers, colon, underscore, or dash." });
      return;
    }
    const bag = postedBag(body);
    if (!bag) {
      bagReadError = "Couldn't read bag";
      res.status(422).json({ error: "Couldn't read bag" });
      return;
    }
    bagReadError = null;
    const bagText = bag.itemNames.join("\n");
    const fingerprint = bagFingerprint(userId, bag.itemNames, bag.totalCents);
    const existing = deps.store
      .listCarts()
      .find((cart) => cart.userId === userId && cart.fingerprint === fingerprint);
    if (existing) {
      if (existing.necessity == null) {
        const keyword = keywordNecessity(bagText);
        applyNecessity(existing, { necessary: keyword.necessary, source: "keywords", reason: keyword.reason });
        if (!keyword.necessary && !existing.lastPing) {
          await pingCart(existing, false);
        }
        deps.store.saveCart(existing);
        refineNecessity(existing.code, bagText);
      }
      await attachImpulse(existing, req.user?.id, "refresh");
      deps.store.saveCart(existing);
      res.json(publicCart(existing, deps.agentHandle));
      return;
    }
    const demo = body.demo === true || (body.demo === undefined && deps.demoDefault);
    const pageHost = typeof body.pageHost === "string" ? body.pageHost.slice(0, 120) : null;
    const cart = startLockedCart({
      items: itemsForBag(bag.itemNames, bag.totalCents, bag.parsed),
      totalCents: bag.totalCents,
      parsedFromPage: bag.parsed,
      pageHost,
      fingerprint,
      now: now(),
      demo,
      lockMs: deps.lockMs,
      userId,
      taken: (code) => deps.store.getCart(code) !== undefined,
    });
    seedDecision(cart);
    if (deps.personalizeNudge && req.user?.id && cart.explanation) {
      cart.explanation = await deps.personalizeNudge(cart.explanation, req.user.id);
    }
    const persona = personaFor(userId, assignedPersonas);
    cart.personaId = persona.id;
    const keyword = keywordNecessity(bagText);
    applyNecessity(cart, { necessary: keyword.necessary, source: "keywords", reason: keyword.reason });
    if (!keyword.necessary) {
      await pingCart(cart, false);
    }
    await attachImpulse(cart, req.user?.id, "create");
    deps.store.saveCart(cart);
    res.status(201).json(publicCart(cart, deps.agentHandle));
    refineNecessity(cart.code, bagText, req.user?.id);
  }));

  app.get("/api/carts/:code", (req, res) => {
    const cart = loadCart(req.params.code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    res.json(publicCart(cart, deps.agentHandle));
  });

  app.post("/api/pay", (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const code = typeof body.code === "string" ? body.code : "";
    const cart = loadCart(code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    const gate = lockState(cart, now());
    res.status(gate.httpStatus).json({ ...gate, code: cart.code, synthetic: true });
  });

  app.post("/api/carts/:code/unlock", settle(async (req, res) => {
    const cart = loadCart(req.params.code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    if (!cart.replied) {
      if (isEnforcedVault(cart, now())) {
        res.status(423).json({
          error: "Checkout stays paused until the hold ends.",
          vaultUntil: cart.vaultUntil,
          cart: publicCart(cart, deps.agentHandle),
        });
        return;
      }
      if (!manualUnlockOpen(env)) {
        res.status(403).json({ error: "Reply with a reason to unlock." });
        return;
      }
    }
    unlockCart(cart, now());
    syncFreeBandCopy(cart);
    deps.store.saveCart(cart);
    scheduler.disarm(cart.code);
    res.json(publicCart(cart, deps.agentHandle));
  }));

  app.post("/api/carts/:code/sleep", (req, res) => {
    const cart = loadCart(req.params.code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    if (!offersSleep(cart.scoreBucket)) {
      res.status(409).json({
        error: "Sleep is only for a soft score.",
        cart: publicCart(cart, deps.agentHandle),
      });
      return;
    }
    sleepCart(cart, now(), deps.lockMs, deps.demoReminderMs, "soft");
    deps.store.saveCart(cart);
    scheduler.arm(cart);
    res.json(publicCart(cart, deps.agentHandle));
  });

  app.post("/api/carts/:code/skip-vault", (req, res) => {
    if (!demoReplyOpen(env)) {
      res.status(403).json({ error: "Not available." });
      return;
    }
    const cart = loadCart(req.params.code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    skipVault(cart, now());
    deps.store.saveCart(cart);
    scheduler.disarm(cart.code);
    res.json(publicCart(cart, deps.agentHandle));
  });

  app.post("/api/carts/:code/notify", settle(async (req, res) => {
    const cart = loadCart(req.params.code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    await pingCart(cart, body.fail === true);
    deps.store.saveCart(cart);
    res.json(publicCart(cart, deps.agentHandle));
  }));

  app.get("/api/phone-link", (req, res) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    if (!isUserId(userId)) {
      res.status(400).json({ error: "userId is required." });
      return;
    }
    const link = deps.store.getPhoneLink(userId);
    res.json({ linked: Boolean(link), conversationId: link?.conversationId ?? null });
  });

  app.post("/api/dev/persona", (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const userId = typeof body.userId === "string" ? body.userId : "";
    const personaId = typeof body.persona === "string" ? body.persona : "";
    if (!isUserId(userId) || !isPersonaId(personaId)) {
      res.status(400).json({ error: "userId and a persona id are required." });
      return;
    }
    assignedPersonas.set(userId, personaId);
    const persona = personaById(personaId);
    const carts = [];
    for (const cart of deps.store.listCarts()) {
      if (cart.userId !== userId || cart.necessity === "necessary") {
        continue;
      }
      cart.personaId = persona.id;
      cart.userImpulseScore = persona.impulseScore;
      if (cart.justificationGrade !== null && cart.gradeSource) {
        const scored = applyPurchaseScore(
          cart,
          { grade: cart.justificationGrade, source: cart.gradeSource, reason: cart.gradeReason ?? "" },
          persona.impulseScore,
          now(),
          deps.demoReminderMs,
        );
        if (scored.bucket === "strict") {
          scheduler.arm(cart);
        } else {
          scheduler.disarm(cart.code);
        }
      }
      deps.store.saveCart(cart);
      carts.push(cart.code);
    }
    res.json({
      personaId: persona.id,
      impulseScore: persona.impulseScore,
      history: persona.history,
      carts,
    });
  });

  app.post("/api/dev/link", (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const userId = typeof body.userId === "string" ? body.userId : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    if (!isUserId(userId) || !DESK_ID.test(conversationId)) {
      res.status(400).json({ error: "userId and a desk conversationId are required." });
      return;
    }
    const link: PhoneLink = { userId, conversationId, linkedAt: now().toISOString() };
    deps.store.savePhoneLink(link);
    res.json({ linked: true, conversationId });
  });

  app.post("/api/dev/reply", settle(async (req, res) => {
    if (!demoReplyOpen(env)) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    const code = typeof body.code === "string" ? body.code : "";
    const cart = loadCart(code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 2_000) {
      res.status(400).json({ error: "Text is required." });
      return;
    }
    // Desk thread only. A simulated reply never uses a Photon conversation id.
    const conversationId = `desk:cart-${cart.code}`;
    await runtime.enqueue({
      id: `demo-${randomUUID()}`,
      conversationId,
      text: `cart ${cart.code} ${text}`,
    });
    const fresh = loadCart(code);
    if (!fresh) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    res.json(publicCart(fresh, deps.agentHandle));
  }));

  app.post("/api/dev/reset", (_req, res) => {
    if (devClosed(res)) {
      return;
    }
    for (const cart of deps.store.listCarts()) {
      scheduler.disarm(cart.code);
    }
    deps.store.reset();
    bagReadError = null;
    res.json({ ok: true });
  });

  app.get("/api/dev/messages", (req, res) => {
    if (devClosed(res)) {
      return;
    }
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    if (!DESK_ID.test(conversationId)) {
      res.status(400).json({ error: "conversationId must look like desk:<id>." });
      return;
    }
    const session = deps.store.getSession(conversationId);
    const linked = session?.cartCode ? deps.store.getCart(session.cartCode) : undefined;
    res.json({ turns: session?.turns ?? [], reading: linked?.reading === true });
  });

  app.post("/api/dev/messages", settle(async (req, res) => {
    if (devClosed(res)) {
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!DESK_ID.test(conversationId)) {
      res.status(400).json({ error: "conversationId must look like desk:<id>." });
      return;
    }
    if (!text || text.length > 2_000) {
      res.status(400).json({ error: "Text is required." });
      return;
    }
    const boundCart = conversationId.match(/^desk:cart-([A-HJ-NP-Z2-9]{6})$/i)?.[1]?.toUpperCase();
    const textForAgent = boundCart && !new RegExp(`\\bcart\\s+${boundCart}\\b`, "i").test(text) ? `cart ${boundCart} ${text}` : text;
    await runtime.enqueue({
      id: `desk-${randomUUID()}`,
      conversationId,
      text: textForAgent,
      ...(req.user?.id ? { authUserId: req.user.id } : {}),
    });
    const session = deps.store.getSession(conversationId);
    res.json({ turns: session?.turns ?? [], reading: false });
  }));

  app.post("/api/dev/checkins/:purchaseId/fire", settle(async (req, res) => {
    if (!demoCheckInsAllowed()) {
      res.status(403).json({ error: "Demo check-ins are off." });
      return;
    }
    if (!deps.checkIns) {
      res.status(503).json({ error: "Check-ins are not running." });
      return;
    }
    const purchaseId = req.params.purchaseId ?? "";
    const result = await fireCheckInNow(purchaseId, {
      now: now(),
      linkFor: linkForUser,
      send: (message) => deliver(message),
    });
    res.status(result.status).json(result.body);
  }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    next(error);
  });

  if (deps.checkIns) {
    const loop = startCheckInLoop({
      now,
      linkFor: linkForUser,
      send: (message) => deliver(message),
      ...(deps.checkIns.intervalMs !== undefined ? { intervalMs: deps.checkIns.intervalMs } : {}),
    });
    stopCheckIns = () => loop.stop();
  }

  return { app, runtime, scheduler, stopCheckIns };

  async function pingCart(cart: Cart, fail: boolean): Promise<void> {
    cart.lastPing = await notifyCheckout({
      store: deps.store,
      cart,
      agentHandle: deps.agentHandle,
      fail,
      now: now(),
      send: async (link, text) => {
        if (link.conversationId.startsWith("desk:")) {
          appendDesk(link.conversationId, text, cart.code);
          return;
        }
        await routeSend({
          conversationId: link.conversationId,
          text,
          ...(link.agentSenderId ? { agentSenderId: link.agentSenderId } : {}),
          idempotencyKey: `simmer:ping:${cart.code}:${link.linkedAt}`,
        });
      },
    });
  }

  function appendDesk(conversationId: string, text: string, cartCode: string): void {
    const existing = deps.store.getSession(conversationId);
    const session: Session = existing ?? {
      conversationId,
      cartCode,
      step: "need_code",
      signals: {},
      turns: [],
      lastInboundId: null,
      signalSource: null,
      updatedAt: now().toISOString(),
    };
    session.cartCode = session.cartCode ?? cartCode;
    session.turns.push({ role: "agent", text });
    session.updatedAt = now().toISOString();
    deps.store.saveSession(session);
  }

  function devClosed(res: Response): boolean {
    if (devRoutesOpen(env)) {
      return false;
    }
    res.status(403).json({ error: "Not available." });
    return true;
  }

  async function acceptCheckIn(message: InboundMessage): Promise<boolean> {
    if (!deps.checkIns) {
      return false;
    }
    const link = deps.store.findPhoneLinkByConversation(message.conversationId);
    return takeCheckInReply(link?.userId ?? null, message.text, deps.checkIns, now());
  }

  function linkForUser(userId: string): { conversationId: string; agentSenderId?: string } | null {
    const link = deps.store.getPhoneLink(userId);
    if (!link) {
      return null;
    }
    return {
      conversationId: link.conversationId,
      ...(link.agentSenderId ? { agentSenderId: link.agentSenderId } : {}),
    };
  }

  async function deliver(message: OutboundMessage): Promise<void> {
    if (message.conversationId.startsWith("desk:")) {
      appendDesk(message.conversationId, message.text, "");
      return;
    }
    await routeSend(message);
  }

  async function attachImpulse(cart: Cart, authUserId: string | undefined, mode: "create" | "refresh"): Promise<void> {
    const wasVault = cart.status === "vault";
    const reading = await readingForCart(authUserId ?? cart.userId, cart, { backboardEnabled });
    applyImpulseReading(cart, reading, now(), deps.demoReminderMs, mode);
    if (!wasVault && cart.status === "vault") {
      scheduler.arm(cart);
    }
    armCountdown(cart);
  }

  function armCountdown(cart: Cart): void {
    const hadReminder = Boolean(cart.reminderFireAt);
    scheduleCountdown(cart, deps.demoReminderMs, deps.demoDefault);
    if (cart.status !== "unlocked" && cart.necessity !== "necessary" && cart.reminderFireAt && !cart.reminderSentAt) {
      scheduler.arm(cart);
      return;
    }
    if (hadReminder && !cart.reminderFireAt) {
      scheduler.disarm(cart.code);
    }
  }

  function loadCart(code: string | undefined): Cart | undefined {
    if (!code) {
      return undefined;
    }
    return deps.store.getCart(code);
  }
}

function seedDecision(cart: Cart): void {
  const signals = withCartFacts({}, cart.totalCents);
  cart.signals = signals;
  cart.decision = decide(signals);
  cart.motiveSources = {
    needVsWant: "default",
    urgency: "default",
    currentPhoneBroken: "default",
    reasonText: "default",
  };
  cart.explanation = phraseDecision(cart.decision, signals, null, cart.motiveSources);
  cart.signalSource = null;
}

function applyNecessity(
  cart: Cart,
  read: { necessary: boolean; source: "grok" | "keywords"; reason: string },
): void {
  cart.necessity = read.necessary ? "necessary" : "unnecessary";
  cart.necessitySource = read.source;
  cart.necessityReason = read.reason;
  if (cart.purchaseScore != null) {
    return;
  }
  if (read.necessary) {
    unlockCart(cart);
    cart.scoreReason = read.reason;
    return;
  }
  if (cart.scoreBucket == null && !isEnforcedVault(cart, new Date())) {
    cart.isUnlocked = false;
    if (cart.status === "unlocked") {
      cart.status = "locked";
    }
    cart.scoreReason = null;
  }
}

function postedBag(body: Record<string, unknown>): { itemNames: string[]; totalCents: number; parsed: true } | null {
  const names = Array.isArray(body.itemNames)
    ? body.itemNames.filter((name): name is string => typeof name === "string").slice(0, 12).map((name) => name.slice(0, 140))
    : [];
  const total = typeof body.totalCents === "number" && Number.isInteger(body.totalCents) ? body.totalCents : null;
  const parsed = body.parsed === true && total !== null && total > 0 && total <= 10_000_000 && names.length > 0;
  if (!parsed || total === null) {
    return null;
  }
  return { itemNames: names, totalCents: total, parsed: true };
}

function publicCart(cart: Cart, agentHandle: string | null) {
  return {
    ...cart,
    impulse: cart.impulse ?? null,
    hoursOfWork: cart.hoursOfWork ?? null,
    hoursOfWorkText: cart.hoursOfWorkText ?? null,
    synthetic: true as const,
    textMessage: prefilledText(cart.code),
    smsLink: textSimmerLink(agentHandle, cart.code),
    linkMessage: cart.userId ? linkPhoneText(cart.userId) : null,
    linkSmsLink: cart.userId ? linkPhoneSms(agentHandle, cart.userId) : null,
    deskPath: deskChatUrl(cart.code),
  };
}

function settle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
