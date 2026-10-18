import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { InMemoryBackboardClient, type BackboardClient } from "../memory/backboard.js";
import { createMemoryRuntime } from "../memory/runtime.js";
import { connectMongo } from "./db.js";
import { attachAccounts, provisionAssistant } from "./routes.js";
import { SESSION_COOKIE, signSession } from "./session.js";
import { MemoryNote, User } from "./user.js";

let base = "";

const SECRET = "http-test-jwt-secret".padEnd(32, "x");
const PASSWORD = "correct horse battery";
const GENERIC_LOGIN_ERROR = { error: "Invalid email or password." };

describe("auth http", () => {
  let mongod: MongoMemoryServer;
  let close: () => Promise<void>;
  let searches: string[] = [];

  before(async () => {
    mongod = await MongoMemoryServer.create({
      binary: { version: "7.0.14" },
    });
    await connectMongo(mongod.getUri());
    await User.createIndexes();
    await MemoryNote.createIndexes();

    const inner = new InMemoryBackboardClient();
    searches = [];
    const client: BackboardClient = {
      createAssistant: (input) => inner.createAssistant(input),
      addMemory: (assistantId, input) => inner.addMemory(assistantId, input),
      getMemoryOperation: () => inner.getMemoryOperation(),
      searchMemories: async (assistantId, query, limit) => {
        searches.push(assistantId);
        return inner.searchMemories(assistantId, query, limit);
      },
      sendMessage: (input) => inner.sendMessage(input),
      resetMemories: (assistantId) => inner.resetMemories(assistantId),
      deleteMemory: (assistantId, memoryId) => inner.deleteMemory(assistantId, memoryId),
    };
    const memory = createMemoryRuntime({}, { client, remote: true });
    const app = express();
    app.use(express.json());
    attachAccounts(app, {
      jwtSecret: SECRET,
      directory: memory.directory,
      memory,
      provision: provisionAssistant(client, memory.directory),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    close = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  });

  after(async () => {
    await close();
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("signs up, sets the session, and rejects a duplicate email in any casing", async () => {
    const created = await post("/auth/signup", { email: "Ada@Example.com", password: PASSWORD });
    assert.equal(created.status, 201);
    const user = created.body.user as { id: string; email: string };
    assert.equal(user.email, "ada@example.com");
    assert.equal("password" in user, false);
    assert.equal("passwordHash" in created.body, false);
    assert.equal(typeof created.body.token, "string");
    assert.ok(created.cookie);
    assert.match(created.setCookie ?? "", /httponly/i);
    const bearer = await get("/auth/me", { authorization: `Bearer ${created.body.token as string}` });
    assert.equal(bearer.status, 200);
    assert.deepEqual(bearer.body.user, { id: user.id, email: "ada@example.com" });

    const me = await get("/auth/me", { cookie: created.cookie ?? "" });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user, { id: user.id, email: "ada@example.com" });

    const stored = await User.findById(user.id);
    assert.ok(stored);
    assert.notEqual(stored.passwordHash, PASSWORD);
    assert.equal(stored.passwordHash.includes(PASSWORD), false);
    assert.equal(stored.passwordHash.startsWith("$argon2"), true);

    const duplicate = await post("/auth/signup", { email: "ADA@example.com", password: "another password" });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, { error: "An account with that email already exists." });
    assert.equal(duplicate.cookie, null);
    assert.equal(await User.countDocuments({ email: "ada@example.com" }), 1);
  });

  it("logs out with 200 while auth is on", async () => {
    const created = await post("/auth/signup", { email: "logout-on@example.com", password: PASSWORD });
    const loggedOut = await post("/auth/logout", {}, created.cookie);
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(loggedOut.body, { ok: true });
    assert.ok(created.setCookie);
    assert.ok(loggedOut.setCookie);
    assert.match(loggedOut.setCookie, /^simmer_token=;/);
    assert.deepEqual(cookieIdentity(loggedOut.setCookie), cookieIdentity(created.setCookie));
  });

  it("logs in with the right password", async () => {
    await post("/auth/signup", { email: "login@example.com", password: PASSWORD });
    const loggedIn = await post("/auth/login", { email: "Login@Example.com", password: PASSWORD });
    assert.equal(loggedIn.status, 200);
    assert.equal((loggedIn.body.user as { email: string }).email, "login@example.com");
    assert.equal(typeof loggedIn.body.token, "string");
    assert.ok(loggedIn.cookie);
    const me = await get("/auth/me", { cookie: loggedIn.cookie ?? "" });
    assert.equal(me.status, 200);
    assert.equal((me.body.user as { email: string }).email, "login@example.com");
  });

  it("returns the same generic error for a wrong password and an unknown email, with no token", async () => {
    await post("/auth/signup", { email: "known@example.com", password: PASSWORD });
    const wrong = await post("/auth/login", { email: "known@example.com", password: "wrong horse battery" });
    const unknown = await post("/auth/login", { email: "missing@example.com", password: PASSWORD });
    assert.equal(wrong.status, unknown.status);
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.deepEqual(wrong.body, GENERIC_LOGIN_ERROR);
    assert.equal(wrong.cookie, null);
    assert.equal(unknown.cookie, null);
    assert.equal("token" in wrong.body, false);
    assert.equal("token" in unknown.body, false);
  });

  it("rejects a missing or bad token on the current-user route", async () => {
    const missing = await get("/auth/me");
    const badCookie = await get("/auth/me", { cookie: "not-a-jwt" });
    const badBearer = await get("/auth/me", { authorization: "Bearer not-a-jwt" });
    const wrongSecret = await signSession(
      { id: "64b1c0f0c0ffee00000000aa", email: "ada@example.com" },
      "other-secret".padEnd(32, "y"),
    );
    const forged = await get("/auth/me", { authorization: `Bearer ${wrongSecret}` });

    for (const rejected of [missing, badCookie, badBearer, forged]) {
      assert.equal(rejected.status, 401);
      assert.deepEqual(rejected.body, { error: "Authentication required." });
      assert.equal(rejected.cookie, null);
      assert.equal("user" in rejected.body, false);
    }
  });

  it("isolates memories between two signed-up users", async () => {
    const secret = "secret-regret-from-a";
    const a = await post("/auth/signup", { email: "a.shopper@example.com", password: PASSWORD });
    const b = await post("/auth/signup", { email: "b.shopper@example.com", password: PASSWORD });
    const aUser = a.body.user as { id: string };
    const bUser = b.body.user as { id: string };
    const aDoc = await User.findById(aUser.id);
    const bDoc = await User.findById(bUser.id);
    assert.ok(aDoc?.backboardAssistantId);
    assert.ok(bDoc?.backboardAssistantId);
    assert.notEqual(aDoc.backboardAssistantId, bDoc.backboardAssistantId);

    const written = await post(
      "/memories",
      { type: "regret", text: secret },
      a.cookie,
    );
    assert.equal(written.status, 201);
    await post("/memories", { type: "goal", text: "b only wants to wait" }, b.cookie);

    const aList = await get("/memories", { cookie: a.cookie ?? "" });
    const bList = await get("/memories", { cookie: b.cookie ?? "" });
    assert.equal(texts(aList.body), secret);
    assert.equal(texts(bList.body).includes(secret), false);
    assert.match(texts(bList.body), /b only wants to wait/);

    const beforeB = searches.length;
    const bSearch = await post("/memories/search", { query: secret }, b.cookie);
    assert.equal(bSearch.status, 200);
    assert.deepEqual(bSearch.body.memories, []);
    assert.deepEqual(searches.slice(beforeB), [bDoc.backboardAssistantId]);

    const beforeA = searches.length;
    const aSearch = await post("/memories/search", { query: secret }, a.cookie);
    assert.equal(aSearch.status, 200);
    assert.equal(texts(aSearch.body), secret);
    assert.equal((aSearch.body.memories as { userId: string }[])[0]?.userId, aUser.id);
    assert.deepEqual(searches.slice(beforeA), [aDoc.backboardAssistantId]);

    const beforeAttacks = searches.length;
    const attacks = [
      get(`/memories?userId=${aUser.id}`, { cookie: b.cookie ?? "" }),
      get(`/memories?user_id=${aUser.id}&assistant_id=${aDoc.backboardAssistantId}`, { cookie: b.cookie ?? "" }),
      get(`/memories/${aUser.id}`, { cookie: b.cookie ?? "" }),
      get(`/memories/${aDoc.backboardAssistantId}`, { cookie: b.cookie ?? "" }),
      get(`/auth/me?userId=${aUser.id}`, { cookie: b.cookie ?? "" }),
      post("/memories/search", { query: secret, userId: aUser.id, assistantId: aDoc.backboardAssistantId }, b.cookie),
      post(`/memories/search?userId=${aUser.id}&assistant_id=${aDoc.backboardAssistantId}`, { query: secret }, b.cookie),
      post("/memories", { type: "goal", text: "smuggled", userId: aUser.id, assistant_id: aDoc.backboardAssistantId }, b.cookie),
    ];
    for (const attack of await Promise.all(attacks)) {
      assert.equal(attack.status, 400);
      assert.equal(JSON.stringify(attack.body).includes(secret), false);
      assert.equal(JSON.stringify(attack.body).includes(aUser.id), false);
    }
    assert.equal(searches.length, beforeAttacks);
    assert.equal(searches.includes(aDoc.backboardAssistantId), true);
    assert.equal(searches.filter((id) => id === aDoc.backboardAssistantId).length, 1);

    const notes = await MemoryNote.find({ text: secret });
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.userId.toString(), aUser.id);
    const stillA = await get("/memories", { cookie: a.cookie ?? "" });
    assert.equal(texts(stillA.body), secret);
  });
});

type HttpResult = {
  status: number;
  body: Record<string, unknown>;
  cookie: string | null;
  setCookie: string | null;
};

async function post(path: string, body: unknown, cookie?: string | null): Promise<HttpResult> {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: { cookie?: string; authorization?: string } = {}): Promise<HttpResult> {
  const requestHeaders: Record<string, string> = {};
  if (headers.cookie) {
    requestHeaders.cookie = `${SESSION_COOKIE}=${headers.cookie}`;
  }
  if (headers.authorization) {
    requestHeaders.authorization = headers.authorization;
  }
  return request(path, { headers: requestHeaders });
}

async function request(path: string, init: RequestInit): Promise<HttpResult> {
  const response = await fetch(`${base}${path}`, init);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cookie: readCookie(response),
    setCookie: setCookieLine(response),
  };
}

function readCookie(response: Response): string | null {
  const line = setCookieLine(response);
  if (!line) {
    return null;
  }
  const pair = line.split(";")[0] ?? "";
  const value = pair.slice(`${SESSION_COOKIE}=`.length);
  return value.length > 0 ? decodeURIComponent(value) : null;
}

function setCookieLine(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines = headers.getSetCookie?.() ?? [];
  return lines.find((line) => line.toLowerCase().startsWith(`${SESSION_COOKIE}=`)) ?? null;
}

function cookieIdentity(setCookie: string): { path: string; sameSite: string; secure: boolean; httpOnly: boolean; domain: string } {
  const attributes = new Map<string, string>();
  for (const part of setCookie.split(";").slice(1)) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      attributes.set(trimmed.toLowerCase(), "");
    } else {
      attributes.set(trimmed.slice(0, eq).toLowerCase(), trimmed.slice(eq + 1));
    }
  }
  return {
    path: attributes.get("path") ?? "",
    sameSite: attributes.get("samesite") ?? "",
    secure: attributes.has("secure"),
    httpOnly: attributes.has("httponly"),
    domain: attributes.get("domain") ?? "",
  };
}

function texts(body: Record<string, unknown>): string {
  const memories = body.memories;
  if (!Array.isArray(memories)) {
    return "";
  }
  return memories
    .map((memory) => (memory && typeof memory === "object" && "text" in memory && typeof memory.text === "string" ? memory.text : ""))
    .join("\n");
}
