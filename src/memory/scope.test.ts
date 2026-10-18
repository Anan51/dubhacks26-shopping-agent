import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import express, { type Request } from "express";

import type { AccountDirectory, AccountUser } from "../auth/accounts.js";
import { createMemoryRouter } from "../auth/routes.js";
import type { BackboardClient, MemoryRecord, MemorySearchHit, MemoryWrite } from "./backboard.js";
import {
  createInMemoryIndex,
  getMemoriesForCurrentUser,
  personalizeNudge,
  rememberForCurrentUser,
  searchMemoriesForCurrentUser,
  ScopeError,
  type MemoryIndex,
} from "./service.js";

const USER = "64b1c0f0c0ffee00000000aa";
const OTHER = "64b1c0f0c0ffee00000000bb";

describe("memory scope", () => {
  it("lists only req.user.id and refuses a client-supplied user or assistant id", async () => {
    const index = createInMemoryIndex();
    await index.insert(record(USER, "goal", "wait a month"));
    await index.insert(record(OTHER, "regret", "bought it anyway"));

    const own = await getMemoriesForCurrentUser(request({ id: USER }), index);
    assert.deepEqual(own.map((memory) => memory.text), ["wait a month"]);

    const attacks = [
      request({ id: USER }, { query: { userId: OTHER } }),
      request({ id: USER }, { body: { userId: OTHER } }),
      request({ id: USER }, { params: { userId: OTHER } }),
      request({ id: USER }, { query: { assistant_id: "asst-evil" } }),
      request({ id: USER }, { body: { assistantId: "asst-stored" } }),
    ];
    for (const attack of attacks) {
      await assert.rejects(() => getMemoriesForCurrentUser(attack, index), ScopeError);
    }

    const listing = recordingIndex();
    await assert.rejects(() => getMemoriesForCurrentUser(request({ id: USER }, { query: { userId: OTHER } }), listing.index), ScopeError);
    assert.deepEqual(listing.calls, []);
  });

  it("writes to the assistant stored on the user, never a client assistant id", async () => {
    const client = fakeClient();
    const directory = directoryOf({
      id: USER,
      email: "ada@example.com",
      passwordHash: "$argon2id$stored",
      backboardAssistantId: "asst-stored",
    });
    const index = createInMemoryIndex();
    const saved = await rememberForCurrentUser(
      request({ id: USER }),
      { type: "returned", text: "the case", meta: { page: "bag" } },
      { directory, client, index, remote: true, sleep: async () => undefined },
    );
    assert.equal(saved.userId, USER);
    assert.deepEqual(client.added, [{ assistantId: "asst-stored", content: "I returned that: the case" }]);
    assert.deepEqual(client.created, []);
    assert.equal(client.sent, 0);

    await assert.rejects(
      () =>
        rememberForCurrentUser(
          request({ id: USER }, { body: { assistant_id: "asst-evil", userId: OTHER } }),
          { type: "goal", text: "save" },
          { directory, client, index, remote: true, sleep: async () => undefined },
        ),
      /Refusing a client-supplied/,
    );
    assert.equal(client.added.length, 1);
  });

  it("creates one assistant for a user who does not have one and ignores body ids", async () => {
    const client = fakeClient();
    const user: AccountUser = {
      id: USER,
      email: "ada@example.com",
      passwordHash: "$argon2id$stored",
      backboardAssistantId: null,
    };
    const directory = directoryOf(user);
    await rememberForCurrentUser(request({ id: USER }), { type: "goal", text: "wait" }, {
      directory,
      client,
      index: createInMemoryIndex(),
      remote: true,
      sleep: async () => undefined,
    });
    assert.deepEqual(client.created, ["Simmer " + USER]);
    assert.equal(client.added[0]?.assistantId, "asst-created");
    assert.equal(user.backboardAssistantId, "asst-created");
  });

  it("does not call the index when Backboard is not configured", async () => {
    let calls = 0;
    const index: MemoryIndex = {
      async insert(record) {
        return record;
      },
      async list() {
        calls += 1;
        return [];
      },
    };
    const text = await personalizeNudge("Waiting.", USER, index, false);
    assert.equal(text, "Waiting.");
    assert.equal(calls, 0);
    const personalized = await personalizeNudge("Waiting.", USER, {
      async insert(record) {
        return record;
      },
      async list(userId) {
        assert.equal(userId, USER);
        return [record(USER, "goal", "save up")];
      },
    }, true);
    assert.match(personalized, /Your goal: save up/);
  });

  it("refuses a client user id over HTTP before listing", async () => {
    const calls: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(
      "/memories",
      createMemoryRouter({
        authenticate(req, _res, next) {
          req.user = { id: USER, email: "ada@example.com" };
          next();
        },
        list(req) {
          return getMemoriesForCurrentUser(req, {
            async insert(record) {
              return record;
            },
            async list(userId) {
              calls.push(userId);
              return [record(userId, "goal", "wait")];
            },
          });
        },
        search() {
          throw new Error("not used");
        },
        add() {
          throw new Error("not used");
        },
      }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const denied = await fetch(`http://127.0.0.1:${address.port}/memories?userId=${OTHER}`);
    assert.equal(denied.status, 400);
    const allowed = await fetch(`http://127.0.0.1:${address.port}/memories`);
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as { memories: { userId: string }[] };
    assert.equal(body.memories[0]?.userId, USER);
    assert.deepEqual(calls, [USER]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("ranks the caller's rows from Backboard hits for a multi-word query", async () => {
    const monitors = record(USER, "regret", "studio monitors", "bb-monitors");
    const headphones = record(USER, "regret", "Bought noise-cancelling headphones for a flight", "bb-phones");
    const cable = record(USER, "goal", "spare headphones audio cable", "bb-cable");
    const client = searchClient([
      { id: "bb-monitors", content: "mentioned speakers", score: 0.93, createdAt: null },
      {
        id: null,
        content: "Regret: Bought noise-cancelling headphones for a flight",
        score: 0.81,
        createdAt: null,
      },
    ]);
    const found = await searchMemoriesForCurrentUser(request({ id: USER }, { body: { query: "headphones audio" } }), {
      directory: directoryOf(account(USER, "asst-ada")),
      client,
      index: listing([cable, headphones, monitors]),
      remote: true,
    });
    assert.equal(
      found.some((memory) => memory.text === "Bought noise-cancelling headphones for a flight"),
      true,
    );
    assert.deepEqual(found, [monitors, headphones]);
    assert.deepEqual(client.calls, [{ assistantId: "asst-ada", query: "headphones audio", limit: 10 }]);
  });

  it("still returns an owned row for a single-word query", async () => {
    const headphones = record(USER, "regret", "Bought noise-cancelling headphones for a flight", "bb-phones");
    const monitors = record(USER, "goal", "studio monitors", "bb-monitors");
    const client = searchClient([
      {
        id: "bb-phones",
        content: "Regret: Bought noise-cancelling headphones for a flight",
        score: 0.88,
        createdAt: null,
      },
    ]);
    const found = await searchMemoriesForCurrentUser(request({ id: USER }, { body: { query: "headphones" } }), {
      directory: directoryOf(account(USER, "asst-ada")),
      client,
      index: listing([monitors, headphones]),
      remote: true,
    });
    assert.deepEqual(found, [headphones]);
    assert.deepEqual(client.calls, [{ assistantId: "asst-ada", query: "headphones", limit: 10 }]);
  });

  it("does not return another user's memory from search", async () => {
    const ada = account(USER, "asst-ada");
    const byron = account(OTHER, "asst-byron");
    const adaMemory = record(USER, "regret", "Bought noise-cancelling headphones for a flight", "bb-ada");
    const byronMemory = record(OTHER, "regret", "headphones audio desk", "bb-byron");
    const client = searchClient([
      { id: "bb-byron", content: "Regret: headphones audio desk", score: 0.99, createdAt: null },
      {
        id: "bb-ada",
        content: "Regret: Bought noise-cancelling headphones for a flight",
        score: 0.4,
        createdAt: null,
      },
    ]);
    const deps = {
      directory: directoryOfUsers([ada, byron]),
      client,
      index: listing([byronMemory, adaMemory]),
      remote: true,
    };
    const found = await searchMemoriesForCurrentUser(request({ id: USER }, { body: { query: "headphones audio" } }), deps);
    assert.deepEqual(found, [adaMemory]);
    assert.equal(
      found.every((memory) => memory.userId === USER),
      true,
    );
    const other = await searchMemoriesForCurrentUser(request({ id: OTHER }, { body: { query: "headphones audio" } }), deps);
    assert.deepEqual(other, [byronMemory]);
    assert.deepEqual(client.calls, [
      { assistantId: "asst-ada", query: "headphones audio", limit: 10 },
      { assistantId: "asst-byron", query: "headphones audio", limit: 10 },
    ]);
    await assert.rejects(
      () =>
        searchMemoriesForCurrentUser(
          request({ id: USER }, { body: { query: "headphones audio", userId: OTHER } }),
          deps,
        ),
      /Refusing a client-supplied/,
    );
    assert.equal(client.calls.length, 2);
  });

  it("matches any query token when Backboard search has no usable hits", async () => {
    const headphones = record(USER, "regret", "Bought noise-cancelling headphones for a flight", "bb-phones");
    const milk = record(USER, "goal", "milk and eggs", null);
    const modes: { remote: boolean; assistantId: string | null; hits: MemorySearchHit[] }[] = [
      { remote: false, assistantId: "asst-ada", hits: [] },
      { remote: true, assistantId: "asst-ada", hits: [] },
      { remote: true, assistantId: null, hits: [] },
      { remote: true, assistantId: "asst-ada", hits: [{ id: null, content: "   ", score: null, createdAt: null }] },
    ];
    for (const mode of modes) {
      const client = searchClient(mode.hits);
      const found = await searchMemoriesForCurrentUser(request({ id: USER }, { body: { query: "headphones audio" } }), {
        directory: directoryOf(account(USER, mode.assistantId)),
        client,
        index: listing([milk, headphones]),
        remote: mode.remote,
      });
      assert.deepEqual(found, [headphones]);
      if (mode.remote && mode.assistantId) {
        assert.deepEqual(client.calls, [{ assistantId: "asst-ada", query: "headphones audio", limit: 10 }]);
      } else {
        assert.deepEqual(client.calls, []);
      }
    }
  });
});

function request(user: { id: string }, extra: { query?: Request["query"]; body?: unknown; params?: Request["params"] } = {}): Request {
  return {
    user: { id: user.id, email: "ada@example.com" },
    query: extra.query ?? {},
    body: extra.body ?? {},
    params: extra.params ?? {},
  } as Request;
}

function record(userId: string, type: MemoryRecordType, text: string, backboardMemoryId: string | null = null) {
  return {
    userId,
    type,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    meta: {},
    backboardMemoryId,
  };
}

type MemoryRecordType = "regret" | "goal" | "returned";

function recordingIndex(): { index: MemoryIndex; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    index: {
      async insert(record) {
        return record;
      },
      async list(userId) {
        calls.push(userId);
        return [];
      },
    },
  };
}

function account(id: string, backboardAssistantId: string | null): AccountUser {
  return {
    id,
    email: `${id}@example.com`,
    passwordHash: "$argon2id$stored",
    backboardAssistantId,
  };
}

function directoryOf(user: AccountUser): AccountDirectory {
  return {
    async findByEmail() {
      return user;
    },
    async findById(id) {
      return id === user.id ? user : null;
    },
    async create() {
      throw new Error("not used");
    },
    async setAssistantId(_id, assistantId) {
      user.backboardAssistantId = assistantId;
    },
  };
}

function directoryOfUsers(users: AccountUser[]): AccountDirectory {
  return {
    async findByEmail(email) {
      return users.find((user) => user.email === email) ?? null;
    },
    async findById(id) {
      return users.find((user) => user.id === id) ?? null;
    },
    async create() {
      throw new Error("not used");
    },
    async setAssistantId(id, assistantId) {
      const user = users.find((entry) => entry.id === id);
      if (user) {
        user.backboardAssistantId = assistantId;
      }
    },
  };
}

function listing(rows: MemoryRecord[]): MemoryIndex {
  return {
    async insert(row) {
      return row;
    },
    async list() {
      return rows;
    },
  };
}

function searchClient(hits: MemorySearchHit[]): BackboardClient & {
  calls: { assistantId: string; query: string; limit: number }[];
} {
  const calls: { assistantId: string; query: string; limit: number }[] = [];
  return {
    calls,
    async createAssistant() {
      throw new Error("not used");
    },
    async addMemory() {
      throw new Error("not used");
    },
    async getMemoryOperation() {
      throw new Error("not used");
    },
    async searchMemories(assistantId: string, query: string, limit: number) {
      calls.push({ assistantId, query, limit });
      return hits;
    },
    async sendMessage() {
      throw new Error("not used");
    },
    async resetMemories() {
      return undefined;
    },
    async deleteMemory() {
      return undefined;
    },
  };
}

function fakeClient(): BackboardClient & { added: { assistantId: string; content: string }[]; created: string[]; sent: number } {
  const added: { assistantId: string; content: string }[] = [];
  const created: string[] = [];
  const client = {
    added,
    created,
    sent: 0,
    async createAssistant(input: { name: string }) {
      created.push(input.name);
      return { assistantId: "asst-created" };
    },
    async addMemory(assistantId: string, input: { content: string }): Promise<MemoryWrite> {
      added.push({ assistantId, content: input.content });
      return { memoryId: "mem-1", operationId: "op-1", status: "IN_PROGRESS" };
    },
    async getMemoryOperation() {
      return { status: "COMPLETED" as const, memoryIds: ["mem-1"] };
    },
    async searchMemories() {
      return [];
    },
    async sendMessage() {
      client.sent += 1;
      throw new Error("sendMessage should not run on the memory write path");
    },
    async resetMemories() {
      return undefined;
    },
    async deleteMemory() {
      return undefined;
    },
  };
  return client;
}
