import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";

import { handleWebhook } from "../api/webhook.js";
import { bagOrFallback } from "./apple-bag.js";
import {
  bagFingerprint,
  FALLBACK_TOTAL_CENTS,
  isVaultActive,
  itemsForBag,
  lockState,
  skipVault,
  sleepCart,
  startLockedCart,
  unlockCart,
  VAULT_MS,
  withCartFacts,
} from "./carts.js";
import type { OutboundMessage } from "./channel.js";
import type { PhotonChannel } from "./channels/photon.js";
import { readConfig } from "./config.js";
import { handleIncomingEvent } from "./handle-message.js";
import { decide, EXAMPLE_OWED_CENTS } from "./heuristic.js";
import { EXAMPLE_OFFERS } from "./offers.js";
import { deskChatUrl, linkPhoneSms, linkPhoneText, prefilledText, textSimmerLink } from "./links.js";
import { isUserId, notifyCheckout } from "./phone-link.js";
import { phraseDecision, polishPhrase } from "./phrase.js";
import { ReminderScheduler } from "./reminders.js";
import { createRuntime, type Runtime } from "./runtime.js";
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
  now?: () => Date;
  polish?: (template: string, action: Decision["action"]) => Promise<string>;
};

export type RunningApp = {
  app: express.Express;
  runtime: Runtime;
  scheduler: ReminderScheduler;
};

export function createApp(deps: AppDeps): RunningApp {
  const now = deps.now ?? (() => new Date());

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
  const runtime = createRuntime({
    store: deps.store,
    now,
    demoReminderMs: deps.demoReminderMs,
    send: (message) => routeSend(message),
    armReminder: (cart) => scheduler.arm(cart),
    disarmReminder: (code) => scheduler.disarm(code),
    polish:
      deps.polish ??
      ((template, action) => polishPhrase(template, action, deps.xaiApiKey, fetch, deps.xaiModel, deps.xaiTimeoutMs)),
    extract: {
      ...(deps.xaiApiKey ? { apiKey: deps.xaiApiKey } : {}),
      model: deps.xaiModel,
      timeoutMs: deps.xaiTimeoutMs,
    },
  });

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

  app.get("/api/config", (_req, res) => {
    res.json({
      synthetic: true,
      channel: deps.photon ? "photon" : "stub",
      grokEnabled: Boolean(deps.xaiApiKey),
      agentHandle: deps.agentHandle,
      lockMs: deps.lockMs,
      demoReminderMs: deps.demoReminderMs,
      demoDefault: deps.demoDefault,
      exampleOwedCents: EXAMPLE_OWED_CENTS,
      fallbackTotalCents: FALLBACK_TOTAL_CENTS,
      exampleOffers: EXAMPLE_OFFERS,
      deskChat: true,
    });
  });

  app.get("/api/carts", (_req, res) => {
    const carts = deps.store.listCarts().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    res.json({ synthetic: true, carts: carts.map((cart) => publicCart(cart, deps.agentHandle)) });
  });

  app.post("/api/carts", settle(async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (!isUserId(userId)) {
      res.status(400).json({ error: "userId must be 4–80 letters, numbers, colon, underscore, or dash." });
      return;
    }
    const bag = postedBag(body);
    const fingerprint = bagFingerprint(userId, bag.itemNames, bag.totalCents);
    const existing = deps.store
      .listCarts()
      .find((cart) => cart.userId === userId && cart.fingerprint === fingerprint);
    if (existing) {
      if (!existing.lastPing?.delivered) {
        await pingCart(existing, false);
        deps.store.saveCart(existing);
      }
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
    await pingCart(cart, false);
    deps.store.saveCart(cart);
    res.status(201).json(publicCart(cart, deps.agentHandle));
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

  app.post("/api/carts/:code/unlock", (req, res) => {
    const cart = loadCart(req.params.code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    if (isVaultActive(cart, now())) {
      res.status(423).json({
        error: "This bag is in the Impulse Vault.",
        vaultUntil: cart.vaultUntil,
        cart: publicCart(cart, deps.agentHandle),
      });
      return;
    }
    unlockCart(cart);
    deps.store.saveCart(cart);
    scheduler.disarm(cart.code);
    res.json(publicCart(cart, deps.agentHandle));
  });

  app.post("/api/carts/:code/sleep", (req, res) => {
    const cart = loadCart(req.params.code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    sleepCart(cart, now(), VAULT_MS, deps.demoReminderMs);
    deps.store.saveCart(cart);
    scheduler.arm(cart);
    res.json(publicCart(cart, deps.agentHandle));
  });

  app.post("/api/carts/:code/skip-vault", (req, res) => {
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

  app.get("/api/dev/messages", (req, res) => {
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
    await runtime.enqueue({
      id: `desk-${randomUUID()}`,
      conversationId,
      text,
    });
    const session = deps.store.getSession(conversationId);
    res.json({ turns: session?.turns ?? [], reading: false });
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

  return { app, runtime, scheduler };

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

function postedBag(body: Record<string, unknown>): { itemNames: string[]; totalCents: number; parsed: boolean } {
  const names = Array.isArray(body.itemNames)
    ? body.itemNames.filter((name): name is string => typeof name === "string").slice(0, 12).map((name) => name.slice(0, 140))
    : [];
  const total = typeof body.totalCents === "number" && Number.isInteger(body.totalCents) ? body.totalCents : null;
  const parsed = body.parsed === true && total !== null && total > 0 && total <= 10_000_000;
  return bagOrFallback({ itemNames: names, totalCents: parsed ? total : null, parsed });
}

function publicCart(cart: Cart, agentHandle: string | null) {
  return {
    ...cart,
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
