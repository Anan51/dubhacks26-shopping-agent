import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";

import type { AccountDirectory } from "../auth/accounts.js";
import { authenticatedUserId, refuseClientScope, ScopeError } from "../memory/service.js";
import type { BackboardClient } from "../memory/backboard.js";
import { isRecord } from "../record.js";
import { readSurvey, submitSurvey, SurveyError } from "./service.js";

export function createOnboardingRouter(deps: {
  authenticate: RequestHandler;
  directory: AccountDirectory;
  client: BackboardClient;
  remote: boolean;
}): Router {
  const router = express.Router();
  router.use(deps.authenticate);

  router.get("/survey", async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      refuseClientScope(req, userId);
      refuseAnyUserId(req);
      res.json(await readSurvey(userId));
    } catch (error: unknown) {
      sendSurveyError(res, error);
    }
  });

  router.post("/survey", async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      refuseClientScope(req, userId);
      refuseAnyUserId(req);
      const survey = await submitSurvey(userId, req.body, deps);
      res.status(201).json(survey);
    } catch (error: unknown) {
      sendSurveyError(res, error);
    }
  });

  return router;
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

function sendSurveyError(res: Response, error: unknown): void {
  if (error instanceof SurveyError || error instanceof ScopeError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error instanceof Error ? error.message : "Survey request failed.");
  res.status(500).json({ error: "Survey request failed." });
}
