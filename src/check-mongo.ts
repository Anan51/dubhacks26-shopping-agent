import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import express from "express";
import mongoose from "mongoose";

import { connectMongo } from "./auth/db.js";
import { redactMongoUri } from "./auth/redact.js";
import { attachAccounts, provisionAssistant } from "./auth/routes.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { MemoryNote, User } from "./auth/user.js";
import { HttpBackboardClient } from "./memory/backboard.js";
import { createMemoryRuntime, type MemoryRuntime } from "./memory/runtime.js";

const SERVER_SELECTION_TIMEOUT_MS = 10_000;

type Step = "connect" | "signup" | "login" | "wrong-password" | "memory" | "cleanup";

type Failure = {
  step: Step;
  reason: string;
};

/**
 * Laptop check for Atlas, email login, and memory.
 * Reads MONGODB_URI from the environment or .env. Does not print the URI or the Backboard key.
 */
export async function runMongoCheck(): Promise<number> {
  loadLocalEnv();
  const uri = process.env.MONGODB_URI?.trim() ?? "";
  if (!uri) {
    console.log("FAIL: connect: MONGODB_URI is unset.");
    return 1;
  }
  if (!process.env.JWT_SECRET?.trim()) {
    process.env.JWT_SECRET = randomBytes(32).toString("hex");
  }

  const failure: { current: Failure | null } = { current: null };
  let connected = false;
  let passed = false;
  let server: Server | null = null;
  let memory: MemoryRuntime | null = null;
  let userId: string | null = null;

  try {
    try {
      await connectMongo(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS, dbName: "simmer" });
      connected = true;
      console.log("connect: ok");
    } catch (error) {
      fail(failure, "connect", error);
    }

    if (!failure.current) {
    const secret = process.env.JWT_SECRET?.trim() ?? "";
    memory = createMemoryRuntime();
    const app = express();
    app.use(express.json());
    attachAccounts(app, {
      jwtSecret: secret,
      directory: memory.directory,
      memory,
      ...(memory.remote ? { provision: provisionAssistant(memory.client, memory.directory) } : {}),
    });
    server = createServer(app);
    const base = await listen(server);

    const email = `checkmongo+${Date.now()}@example.com`;
    const password = randomBytes(18).toString("base64url");

    const created = await post(base, "/auth/signup", { email, password });
    const createdUser = userFrom(created.body);
    if (createdUser) {
      userId = createdUser.id;
    }
    if (created.status !== 201 || !created.cookie || !createdUser) {
      fail(failure, "signup", `status ${created.status}${errorSuffix(created.body)}`);
    } else {
      console.log("signup: ok");
      const loggedIn = await post(base, "/auth/login", { email, password });
      const loggedInUser = userFrom(loggedIn.body);
      if (loggedIn.status !== 200 || !loggedIn.cookie || loggedInUser?.id !== userId) {
        fail(failure, "login", `status ${loggedIn.status}${errorSuffix(loggedIn.body)}`);
      } else {
        console.log("login: ok");
        const wrong = await post(base, "/auth/login", { email, password: `${password}no` });
        if (wrong.status !== 401 || wrong.cookie) {
          fail(failure, "wrong-password", `status ${wrong.status}${errorSuffix(wrong.body)}`);
        } else {
          console.log("wrong-password: ok");
          const text = `check-mongo ${Date.now()}`;
          const written = await post(base, "/memories", { type: "goal", text }, loggedIn.cookie);
          const readback =
            written.status === 201
              ? memory.remote
                ? await post(base, "/memories/search", { query: text }, loggedIn.cookie)
                : await get(base, "/memories", loggedIn.cookie)
              : null;
          if (written.status !== 201 || !readback || readback.status !== 200 || !bodyHasText(readback.body, text)) {
            const status = written.status !== 201 ? written.status : (readback?.status ?? 0);
            const body = written.status !== 201 ? written.body : readback?.body;
            fail(failure, "memory", `${written.status === 201 ? "read" : "write"} status ${status}${errorSuffix(body)}`);
          } else {
            console.log(`memory: ok (${memory.remote ? "backboard" : "in-memory fallback"})`);
            passed = true;
          }
        }
      }
    }
    }
  } catch (error) {
    if (!failure.current) {
      fail(failure, "signup", error);
    }
  } finally {
    if (connected) {
      try {
        await removeFixture(userId, memory);
        console.log("cleanup: ok");
      } catch (error) {
        console.log("cleanup: failed");
        if (!failure.current) {
          fail(failure, "cleanup", error);
          passed = false;
        }
      }
    }
    await closeServer(server);
    await mongoose.disconnect().catch(() => undefined);
  }

  if (failure.current) {
    console.log(`FAIL: ${failure.current.step}: ${failure.current.reason}`);
    return 1;
  }
  return passed ? 0 : 1;
}

function fail(box: { current: Failure | null }, step: Step, error: unknown): void {
  box.current = { step, reason: presentable(error) };
}

async function removeFixture(userId: string | null, memory: MemoryRuntime | null): Promise<void> {
  if (!userId) {
    return;
  }
  const user = await User.findById(userId);
  const assistantId = user?.backboardAssistantId ?? null;
  if (assistantId && memory?.client instanceof HttpBackboardClient) {
    await memory.client.deleteAssistant(assistantId);
  }
  await MemoryNote.deleteMany({ userId });
  await User.deleteOne({ _id: userId });
}

function loadLocalEnv(): void {
  const file = path.join(process.cwd(), ".env");
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function presentable(error: unknown): string {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error && error.message
        ? error.message
        : "request failed";
  const key = process.env.BACKBOARD_API_KEY?.trim() ?? "";
  const withoutKey = key.length > 0 ? raw.split(key).join("[redacted]") : raw;
  return redactMongoUri(withoutKey);
}

function errorSuffix(body: unknown): string {
  if (!isRecord(body) || typeof body.error !== "string" || body.error.length === 0) {
    return "";
  }
  return `: ${presentable(new Error(body.error))}`;
}

function userFrom(body: unknown): { id: string } | null {
  if (!isRecord(body) || !isRecord(body.user) || typeof body.user.id !== "string") {
    return null;
  }
  return { id: body.user.id };
}

function bodyHasText(body: unknown, text: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.memories)) {
    return false;
  }
  return body.memories.some((memory) => isRecord(memory) && memory.text === text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function post(base: string, path: string, body: unknown, cookie?: string): Promise<HttpResult> {
  return request(base, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(base: string, path: string, cookie: string): Promise<HttpResult> {
  return request(base, path, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
}

async function request(base: string, path: string, init: RequestInit): Promise<HttpResult> {
  const response = await fetch(`${base}${path}`, init);
  return {
    status: response.status,
    body: (await response.json()) as unknown,
    cookie: readCookie(response),
  };
}

function readCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const line = (headers.getSetCookie?.() ?? []).find((item) => item.toLowerCase().startsWith(`${SESSION_COOKIE}=`));
  if (!line) {
    return null;
  }
  const pair = line.split(";")[0] ?? "";
  const value = pair.slice(`${SESSION_COOKIE}=`.length);
  return value.length > 0 ? decodeURIComponent(value) : null;
}

type HttpResult = {
  status: number;
  body: unknown;
  cookie: string | null;
};

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runMongoCheck()
    .then((code) => {
      if (code === 0) {
        console.log("PASS");
      }
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.log(`FAIL: connect: ${presentable(error)}`);
      process.exit(1);
    });
}
