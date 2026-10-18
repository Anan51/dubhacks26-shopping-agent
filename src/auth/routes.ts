import express, { type Request, type RequestHandler, type Response, type Router } from "express";

import type { BackboardClient } from "../memory/backboard.js";
import { type MemoryRuntime, type RememberInput } from "../memory/runtime.js";
import { assistantForUser, authenticatedUserId, refuseClientScope, ScopeError } from "../memory/service.js";
import { AccountError, logIn, publicUser, signUp, type AccountDirectory, type AccountUser } from "./accounts.js";
import { mongoState, mongoUnavailableMessage } from "./db.js";
import { clearSessionCookie, readSession, requireUser, setSessionCookie, signSession, tokenFromRequest } from "./session.js";

export type AuthRouteDeps = {
  jwtSecret: string | null;
  ready: () => boolean;
  unavailableMessage: () => string;
  directory: AccountDirectory;
  /** Runs after the account exists. Failures are logged and do not roll back signup. */
  afterCreate?: (user: AccountUser) => Promise<void>;
};

export type MemoryRouteDeps = {
  authenticate: RequestHandler;
  list: MemoryRuntime["list"];
  search: MemoryRuntime["search"];
  add: (req: Request) => Promise<unknown>;
};

export function attachAccounts(
  app: express.Express,
  options: {
    jwtSecret: string | null;
    directory: AccountDirectory;
    memory: MemoryRuntime;
    provision?: (user: AccountUser) => Promise<void>;
  },
): void {
  app.use(
    "/auth",
    createAuthRouter({
      jwtSecret: options.jwtSecret,
      ready: () => mongoState() === "ready",
      unavailableMessage: () => (options.jwtSecret ? mongoUnavailableMessage() : "JWT_SECRET is not configured."),
      directory: options.directory,
      ...(options.provision ? { afterCreate: options.provision } : {}),
    }),
  );
  const authenticate =
    options.jwtSecret && mongoState() === "ready"
      ? requireUser(options.jwtSecret)
      : (_req: Request, res: Response) => {
          res.status(503).json({ error: options.jwtSecret ? mongoUnavailableMessage() : "JWT_SECRET is not configured." });
        };
  app.use(
    "/memories",
    createMemoryRouter({
      authenticate,
      list: (req) => options.memory.list(req),
      search: (req) => options.memory.search(req),
      add: (req) => addFromRequest(req, options.memory),
    }),
  );
}

export function createAuthRouter(deps: AuthRouteDeps): Router {
  const router = express.Router();

  router.post("/signup", async (req, res) => {
    if (!deps.jwtSecret || !deps.ready()) {
      res.status(503).json({ error: deps.unavailableMessage() });
      return;
    }
    try {
      const body = isRecord(req.body) ? req.body : {};
      const user = await signUp(deps.directory, {
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      if (deps.afterCreate) {
        try {
          await deps.afterCreate(user);
        } catch (error: unknown) {
          console.error(error instanceof Error ? error.message : "Backboard assistant was not created.");
        }
      }
      const token = await signSession({ id: user.id, email: user.email }, deps.jwtSecret);
      setSessionCookie(res, token);
      res.status(201).json({ user: publicUser(user) });
    } catch (error: unknown) {
      sendAccountError(res, error);
    }
  });

  router.post("/login", async (req, res) => {
    if (!deps.jwtSecret || !deps.ready()) {
      res.status(503).json({ error: deps.unavailableMessage() });
      return;
    }
    try {
      const body = isRecord(req.body) ? req.body : {};
      const user = await logIn(deps.directory, {
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      const token = await signSession({ id: user.id, email: user.email }, deps.jwtSecret);
      setSessionCookie(res, token);
      res.json({ user: publicUser(user) });
    } catch (error: unknown) {
      sendAccountError(res, error);
    }
  });

  router.post("/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  if (deps.jwtSecret) {
    const jwtSecret = deps.jwtSecret;
    router.get("/me", async (req, res) => {
      if (!deps.ready()) {
        res.status(503).json({ error: deps.unavailableMessage() });
        return;
      }
      const token = tokenFromRequest(req);
      const session = token ? await readSession(token, jwtSecret) : null;
      if (!session) {
        res.status(401).json({ error: "Authentication required." });
        return;
      }
      req.user = session;
      try {
        refuseClientScope(req, authenticatedUserId(req));
        const user = await deps.directory.findById(session.id);
        if (!user) {
          res.status(401).json({ error: "Authentication required." });
          return;
        }
        res.json({ user: publicUser(user) });
      } catch (error: unknown) {
        sendScopeError(res, error);
      }
    });
  }

  return router;
}

export function createMemoryRouter(deps: MemoryRouteDeps): Router {
  const router = express.Router();
  router.use(deps.authenticate);

  router.get("/", async (req, res) => {
    try {
      res.json({ memories: await deps.list(req) });
    } catch (error: unknown) {
      sendScopeError(res, error);
    }
  });

  router.post("/search", async (req, res) => {
    try {
      res.json({ memories: await deps.search(req) });
    } catch (error: unknown) {
      sendScopeError(res, error);
    }
  });

  router.get("/:userId", async (req, res) => {
    try {
      res.json({ memories: await deps.list(req) });
    } catch (error: unknown) {
      sendScopeError(res, error);
    }
  });

  router.post("/", async (req, res) => {
    try {
      res.status(201).json({ memory: await deps.add(req) });
    } catch (error: unknown) {
      sendScopeError(res, error);
    }
  });

  return router;
}

export function provisionAssistant(client: BackboardClient, directory: AccountDirectory): (user: AccountUser) => Promise<void> {
  return async (user) => {
    await assistantForUser(user, directory, client);
  };
}

async function addFromRequest(req: Request, memory: MemoryRuntime): Promise<unknown> {
  const parsed = parseRemember(req.body);
  if (!parsed) {
    throw new ScopeError("type must be regret, goal, or returned, and text is required.");
  }
  return memory.add(req, parsed);
}

function parseRemember(body: unknown): RememberInput | null {
  if (!isRecord(body) || typeof body.text !== "string") {
    return null;
  }
  const text = body.text.trim();
  if (!text || text.length > 2_000) {
    return null;
  }
  if (body.type !== "regret" && body.type !== "goal" && body.type !== "returned") {
    return null;
  }
  const meta = isRecord(body.meta) ? body.meta : undefined;
  return { type: body.type, text, ...(meta ? { meta } : {}) };
}

function sendAccountError(res: Response, error: unknown): void {
  if (error instanceof AccountError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error instanceof Error ? error.message : "Account request failed.");
  res.status(500).json({ error: "Account request failed." });
}

function sendScopeError(res: Response, error: unknown): void {
  if (error instanceof ScopeError) {
    const status = error.message === "Authentication required." ? 401 : 400;
    res.status(status).json({ error: error.message });
    return;
  }
  console.error(error instanceof Error ? error.message : "Memory request failed.");
  res.status(500).json({ error: "Memory request failed." });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
