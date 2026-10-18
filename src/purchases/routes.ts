import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";

import type { AccountDirectory } from "../auth/accounts.js";
import { authenticatedUserId, refuseClientScope, ScopeError } from "../memory/service.js";
import type { BackboardClient } from "../memory/backboard.js";
import { isRecord } from "../record.js";
import { ensureCheckIn } from "../checkins/service.js";
import { historyLimit, insertRealPurchase, listPurchases, PurchaseError, setPurchaseFeedback, type PurchaseFeedback } from "./service.js";

export function createPurchaseRouter(deps: {
  authenticate: RequestHandler;
  directory: AccountDirectory;
  client: BackboardClient;
  remote: boolean;
}): Router {
  const router = express.Router();
  router.use(deps.authenticate);

  router.post("/", async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      refuseClientScope(req, userId);
      refuseAnyUserId(req);
      const purchase = await insertRealPurchase({ userId, feedback: null, ...readCompletedPurchase(req) });
      await ensureCheckIn(userId, purchase._id);
      res.status(201).json({ purchase });
    } catch (error: unknown) {
      sendPurchaseError(res, error);
    }
  });

  router.get("/history", async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      refuseClientScope(req, userId);
      const purchases = await listPurchases(userId, historyLimit(req.query.limit));
      res.json({ purchases });
    } catch (error: unknown) {
      sendPurchaseError(res, error);
    }
  });

  router.post("/:id/feedback", async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      refuseClientScope(req, userId);
      const feedback = readFeedback(req);
      const purchase = await setPurchaseFeedback(userId, req.params.id ?? "", feedback, deps);
      res.json({ purchase });
    } catch (error: unknown) {
      sendPurchaseError(res, error);
    }
  });

  return router;
}

function readCompletedPurchase(req: Request): { item: string; category: string; price: number; verdict: string | null } {
  if (!isRecord(req.body)) {
    throw new PurchaseError(400, "item, category, and price are required.");
  }
  const item = typeof req.body.item === "string" ? req.body.item.trim() : "";
  const category = typeof req.body.category === "string" ? req.body.category.trim() : "";
  const price = req.body.price;
  if (!item || item.length > 200 || !category || category.length > 40 || !isMoney(price)) {
    throw new PurchaseError(400, "item, category, and price are required.");
  }
  const verdict = readVerdict(req.body.verdict);
  return { item, category, price, verdict };
}

function readVerdict(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 40) {
    throw new PurchaseError(400, "verdict must be a short string or null.");
  }
  return value.trim();
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000_000;
}

function refuseAnyUserId(req: Request): void {
  const sources: unknown[] = [req.query, req.body, req.params];
  for (const source of sources) {
    if (!isRecord(source)) {
      continue;
    }
    if ("userId" in source || "user_id" in source) {
      throw new ScopeError(400, "Refusing a client-supplied user id.");
    }
  }
}

function readFeedback(req: Request): PurchaseFeedback | null {
  if (!isRecord(req.body) || !("feedback" in req.body)) {
    throw new PurchaseError(400, "feedback must be regretted, kept, or null.");
  }
  const feedback = req.body.feedback;
  if (feedback === null) {
    return null;
  }
  if (feedback === "regretted" || feedback === "kept") {
    return feedback;
  }
  throw new PurchaseError(400, "feedback must be regretted, kept, or null.");
}

function sendPurchaseError(res: Response, error: unknown): void {
  if (error instanceof PurchaseError || error instanceof ScopeError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error instanceof Error ? error.message : "Purchase request failed.");
  res.status(500).json({ error: "Purchase request failed." });
}
