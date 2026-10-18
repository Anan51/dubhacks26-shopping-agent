import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import express from "express";

import { createMemoryRuntime } from "../memory/runtime.js";
import { attachAccounts } from "./routes.js";

describe("auth disabled", () => {
  let base = "";
  let close: () => Promise<void>;

  before(async () => {
    const memory = createMemoryRuntime({});
    const app = express();
    app.use(express.json());
    attachAccounts(app, {
      jwtSecret: null,
      directory: memory.directory,
      memory,
    });
    app.use((_req, res) => {
      res.status(200).type("html").send("<!doctype html><html></html>");
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
  });

  it("returns 503 for /auth/me and /auth/logout", async () => {
    const me = await fetch(`${base}/auth/me`);
    const logout = await fetch(`${base}/auth/logout`, { method: "POST" });
    const signup = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    });
    assert.equal(me.status, 503);
    assert.equal(logout.status, 503);
    assert.equal(signup.status, 503);
    assert.equal(me.headers.get("content-type")?.includes("text/html"), false);
    assert.deepEqual(await me.json(), { error: "JWT_SECRET is not configured." });
    assert.deepEqual(await logout.json(), { error: "JWT_SECRET is not configured." });
    assert.deepEqual(await signup.json(), { error: "JWT_SECRET is not configured." });
    assert.equal(logout.headers.get("set-cookie"), null);
  });
});
