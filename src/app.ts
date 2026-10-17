import { randomUUID } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";

import { handleWebhook } from "../api/webhook.js";
import { createCart } from "./carts.js";
import { CATALOG, itemsForIds } from "./catalog.js";
import type { OutboundMessage } from "./channel.js";
import type { PhotonChannel } from "./channels/photon.js";
import { readConfig } from "./config.js";
import { handleIncomingEvent } from "./handle-message.js";
import { deskChatUrl, prefilledText, textWaitMateLink } from "./links.js";
import { polishPhrase } from "./phrase.js";
import { ReminderScheduler } from "./reminders.js";
import { createRuntime, type Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import type { Cart, Decision } from "./types.js";

const DESK_ID = /^desk:[A-Za-z0-9-]{8,80}$/;

export type AppDeps = {
  store: Store;
  origin: string;
  coolingMs: number;
  lockThresholdCents: number | null;
  demoReminderMs: number;
  demoDefault: boolean;
  agentHandle: string | null;
  photon: PhotonChannel | null;
  xaiApiKey?: string;
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
    polish: deps.polish ?? ((template, action) => polishPhrase(template, action, deps.xaiApiKey)),
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

  app.get("/api/config", (_req, res) => {
    res.json({
      synthetic: true,
      channel: deps.photon ? "photon" : "stub",
      agentHandle: deps.agentHandle,
      coolingMs: deps.coolingMs,
      lockThresholdCents: deps.lockThresholdCents,
      demoReminderMs: deps.demoReminderMs,
      demoDefault: deps.demoDefault,
      deskChat: true,
    });
  });

  app.get("/api/catalog", (_req, res) => {
    res.json({ synthetic: true, products: CATALOG });
  });

  app.post("/api/carts", (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const itemIds = body.itemIds;
    if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== "string")) {
      res.status(400).json({ error: "itemIds must be a list of product ids." });
      return;
    }
    const items = itemsForIds(itemIds);
    if (!items) {
      res.status(400).json({ error: "Unknown product." });
      return;
    }
    const demo = body.demo === true || (body.demo === undefined && deps.demoDefault);
    try {
      const cart = createCart({
        items,
        now: now(),
        demo,
        coolingMs: deps.coolingMs,
        lockThresholdCents: deps.lockThresholdCents,
        taken: (code) => deps.store.getCart(code) !== undefined,
      });
      deps.store.saveCart(cart);
      res.status(201).json(publicCart(cart, deps.agentHandle));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not start checkout." });
    }
  });

  app.get("/api/carts/:code", (req, res) => {
    const code = req.params.code?.toUpperCase();
    if (!code) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    const cart = deps.store.getCart(code);
    if (!cart) {
      res.status(404).json({ error: "Cart not found." });
      return;
    }
    res.json(publicCart(cart, deps.agentHandle));
  });

  app.get("/api/dev/messages", (req, res) => {
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    if (!DESK_ID.test(conversationId)) {
      res.status(400).json({ error: "conversationId must look like desk:<id>." });
      return;
    }
    res.json({ turns: deps.store.getSession(conversationId)?.turns ?? [] });
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
    res.json({ turns: deps.store.getSession(conversationId)?.turns ?? [] });
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
}

function publicCart(cart: Cart, agentHandle: string | null) {
  return {
    ...cart,
    synthetic: true as const,
    textMessage: prefilledText(cart.code),
    smsLink: agentHandle ? textWaitMateLink(agentHandle, cart.code) : null,
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
