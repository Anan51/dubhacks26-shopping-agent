import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import express from "express";
import mongoose from "mongoose";

import { createMemoryRuntime } from "../memory/runtime.js";
import type { AccountDirectory } from "./accounts.js";
import { connectMongo, mongoState } from "./db.js";
import { attachAccounts } from "./routes.js";
import { SESSION_COOKIE, setSessionCookie } from "./session.js";

const SECRET = "logout-test-jwt-secret-32bytes!!";

describe("logout while Mongo is unavailable", { concurrency: false }, () => {
  let base = "";
  let close: () => Promise<void> = () => Promise.resolve();

  before(async () => {
    assert.equal(new TextEncoder().encode(SECRET).byteLength >= 32, true);
    await connectMongo("mongodb://127.0.0.1:1/simmer-logout", { serverSelectionTimeoutMS: 300 }).catch(() => undefined);
    assert.equal(mongoState(), "error");

    const memory = createMemoryRuntime({});
    const app = express();
    app.use(express.json());
    attachAccounts(app, {
      jwtSecret: SECRET,
      directory: throwingDirectory(),
      memory,
    });
    app.post("/test/set-cookie", (_req, res) => {
      setSessionCookie(res, "sample-token");
      res.json({ ok: true });
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    close = () => closeServer(server);
  });

  after(async () => {
    await close();
    await mongoose.disconnect().catch(() => undefined);
  });

  it("returns a clearing Set-Cookie for simmer_token instead of 503", async () => {
    const me = await fetch(`${base}/auth/me`);
    const logout = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const set = await fetch(`${base}/test/set-cookie`, { method: "POST" });

    assert.equal(me.status, 503);
    assert.deepEqual(await me.json(), { error: "MongoDB is unavailable." });
    assert.equal(setCookieLine(me), null);

    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });
    const cleared = setCookieLine(logout);
    const issued = setCookieLine(set);
    assert.ok(cleared);
    assert.ok(issued);
    assert.equal(cookiePair(cleared).name, SESSION_COOKIE);
    assert.equal(cookiePair(cleared).value, "");
    assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    assert.deepEqual(cookieIdentity(cleared), cookieIdentity(issued));
    assert.equal(cookieIdentity(cleared).path, "/");
    assert.equal(cookieIdentity(cleared).sameSite, "Lax");
    assert.equal(cookieIdentity(cleared).httpOnly, true);
    assert.equal(cookieIdentity(cleared).secure, process.env.NODE_ENV === "production");
  });

  it("keeps Path, SameSite, and Secure aligned when the session cookie is Secure", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const logout = await fetch(`${base}/auth/logout`, { method: "POST" });
      const set = await fetch(`${base}/test/set-cookie`, { method: "POST" });
      assert.equal(logout.status, 200);
      assert.deepEqual(await logout.json(), { ok: true });
      const cleared = setCookieLine(logout);
      const issued = setCookieLine(set);
      assert.ok(cleared);
      assert.ok(issued);
      assert.equal(cookiePair(cleared).value, "");
      assert.deepEqual(cookieIdentity(cleared), cookieIdentity(issued));
      assert.equal(cookieIdentity(cleared).path, "/");
      assert.equal(cookieIdentity(cleared).sameSite, "Lax");
      assert.equal(cookieIdentity(cleared).secure, true);
      assert.equal(cookieIdentity(cleared).httpOnly, true);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });
});

function throwingDirectory(): AccountDirectory {
  const fail = async (): Promise<never> => {
    throw new Error("directory should not be used");
  };
  return {
    findByEmail: fail,
    findById: fail,
    create: fail,
    setAssistantId: async () => {
      throw new Error("directory should not be used");
    },
  };
}

function cookiePair(setCookie: string): { name: string; value: string } {
  const pair = setCookie.split(";")[0] ?? "";
  const eq = pair.indexOf("=");
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
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

function setCookieLine(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines = headers.getSetCookie?.() ?? [];
  return lines.find((line) => line.toLowerCase().startsWith(`${SESSION_COOKIE}=`)) ?? null;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
