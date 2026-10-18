import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";

import type { AccountDirectory } from "../auth/accounts.js";
import { authenticatedUserId, refuseClientScope, ScopeError } from "../memory/service.js";
import type { BackboardClient } from "../memory/backboard.js";
import { isRecord } from "../record.js";
import { historyLimit, listPurchases, PurchaseError, setPurchaseFeedback, type PurchaseFeedback } from "./service.js";

export function createPurchaseRouter(deps: {
  authenticate: RequestHandler;
  directory: AccountDirectory;
  client: BackboardClient;
  remote: boolean;
}): Router {
  const router = express.Router();
  router.use(deps.authenticate);

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
