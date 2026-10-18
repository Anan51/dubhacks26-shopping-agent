import type { Request } from "express";

import type { AccountDirectory, AccountUser } from "../auth/accounts.js";
import { MemoryNote } from "../auth/user.js";
import { isRecord } from "../record.js";
import {
  waitForMemoryWrite,
  type BackboardClient,
  type MemoryKind,
  type MemoryRecord,
} from "./backboard.js";

export class ScopeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ScopeError";
    this.status = status;
  }
}

export type MemoryIndex = {
  insert(record: MemoryRecord): Promise<MemoryRecord>;
  list(userId: string): Promise<MemoryRecord[]>;
};

const ASSISTANT_PROMPT = "You remember one shopper's regrets, goals, and items they returned. Do not invent purchases.";

/** Client ids in the query, body, params, or meta are refused. The only id used is req.user.id. */
export async function getMemoriesForCurrentUser(req: Request, index: MemoryIndex): Promise<MemoryRecord[]> {
  const userId = authenticatedUserId(req);
  refuseClientScope(req, userId);
  return ownedMemories(index, userId);
}

export async function searchMemoriesForCurrentUser(
  req: Request,
  deps: {
    directory: AccountDirectory;
    client: BackboardClient;
    index: MemoryIndex;
    remote: boolean;
  },
): Promise<MemoryRecord[]> {
  const userId = authenticatedUserId(req);
  refuseClientScope(req, userId);
  const query = readSearchQuery(req);
  if (!query) {
    throw new ScopeError(400, "query is required.");
  }
  const user = await deps.directory.findById(userId);
  if (!user) {
    throw new ScopeError(401, "Authentication required.");
  }
  const owned = await ownedMemories(deps.index, userId);
  // Backboard hits have no Simmer user id. The response stays the Mongo rows for req.user.id.
  if (deps.remote && user.backboardAssistantId) {
    await deps.client.searchMemories(user.backboardAssistantId, query, 10);
  }
  const needle = query.toLowerCase();
  return owned.filter((memory) => memory.text.toLowerCase().includes(needle) || memoryContent(memory.type, memory.text).toLowerCase().includes(needle));
}

export function authenticatedUserId(req: Request): string {
  const id = req.user?.id?.trim() ?? "";
  if (!id) {
    throw new ScopeError(401, "Authentication required.");
  }
  return id;
}

export function refuseClientScope(req: Request, userId: string): void {
  if (supplied(req, ["assistantId", "assistant_id"])) {
    throw new ScopeError(400, "Refusing a client-supplied assistant id.");
  }
  const requestedUser = supplied(req, ["userId", "user_id"]);
  if (requestedUser && requestedUser !== userId) {
    throw new ScopeError(400, "Refusing a client-supplied user id.");
  }
}

export async function rememberForCurrentUser(
  req: Request,
  input: { type: MemoryKind; text: string; meta?: Record<string, unknown> },
  deps: {
    directory: AccountDirectory;
    client: BackboardClient;
    index: MemoryIndex;
    remote: boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<MemoryRecord> {
  const userId = authenticatedUserId(req);
  refuseClientScope(req, userId);
  refuseMetaScope(input.meta);
  const user = await deps.directory.findById(userId);
  if (!user) {
    throw new ScopeError(401, "Authentication required.");
  }

  let backboardMemoryId: string | null = null;
  if (deps.remote) {
    const assistantId = await assistantForUser(user, deps.directory, deps.client);
    const write = await deps.client.addMemory(assistantId, {
      content: memoryContent(input.type, input.text),
      metadata: { type: input.type },
    });
    const settled = await waitForMemoryWrite(deps.client, write, deps.sleep);
    if (settled.status === "ERROR") {
      throw new Error("Backboard memory write failed.");
    }
    if (settled.status === "IN_PROGRESS") {
      throw new Error("Backboard memory write is still in progress.");
    }
    backboardMemoryId = settled.memoryId;
  }

  return deps.index.insert({
    userId,
    type: input.type,
    text: input.text,
    createdAt: new Date().toISOString(),
    meta: input.meta ?? {},
    backboardMemoryId,
  });
}

/** No parameter for a client assistant id. The stored id is the only one used. */
export async function assistantForUser(
  user: AccountUser,
  directory: AccountDirectory,
  client: BackboardClient,
): Promise<string> {
  if (user.backboardAssistantId) {
    return user.backboardAssistantId;
  }
  const created = await client.createAssistant({
    name: `Simmer ${user.id}`.slice(0, 255),
    systemPrompt: ASSISTANT_PROMPT,
  });
  await directory.setAssistantId(user.id, created.assistantId);
  user.backboardAssistantId = created.assistantId;
  return created.assistantId;
}

function memoryContent(type: MemoryKind, text: string): string {
  switch (type) {
    case "regret":
      return `Regret: ${text}`;
    case "goal":
      return `Goal: ${text}`;
    case "returned":
      return `I returned that: ${text}`;
    default:
      return assertNever(type);
  }
}

export function createInMemoryIndex(): MemoryIndex {
  const records: MemoryRecord[] = [];
  return {
    async insert(record) {
      records.push(record);
      return record;
    },
    async list(userId) {
      return records.filter((record) => record.userId === userId);
    },
  };
}

export function createMongoMemoryIndex(): MemoryIndex {
  return {
    async insert(record) {
      const doc = await MemoryNote.create({
        userId: record.userId,
        type: record.type,
        text: record.text,
        meta: record.meta,
        backboardMemoryId: record.backboardMemoryId,
      });
      return {
        userId: doc.userId.toString(),
        type: record.type,
        text: doc.text,
        createdAt: doc.createdAt?.toISOString() ?? record.createdAt,
        meta: isRecord(doc.meta) ? doc.meta : {},
        backboardMemoryId: doc.backboardMemoryId ?? null,
      };
    },
    async list(userId) {
      const docs = await MemoryNote.find({ userId }).sort({ createdAt: -1 }).limit(50);
      return docs.map((doc) => ({
        userId: doc.userId.toString(),
        type: asKind(doc.type),
        text: doc.text,
        createdAt: doc.createdAt?.toISOString() ?? new Date(0).toISOString(),
        meta: isRecord(doc.meta) ? doc.meta : {},
        backboardMemoryId: doc.backboardMemoryId ?? null,
      }));
    },
  };
}

function personalizeNudgeText(base: string, memories: MemoryRecord[]): string {
  const goal = latest(memories, "goal");
  const regret = latest(memories, "regret");
  const returned = latest(memories, "returned");
  const lines: string[] = [];
  if (goal) {
    lines.push(`Your goal: ${clip(goal.text)}`);
  }
  if (regret) {
    lines.push(`A regret you named: ${clip(regret.text)}`);
  }
  if (returned) {
    lines.push(`You returned that: ${clip(returned.text)}`);
  }
  if (lines.length === 0) {
    return base;
  }
  return `${base}\n\n${lines.join(" ")}`;
}

/** Reads the Mongo index only. A nudge must not call POST /threads/messages. */
export async function personalizeNudge(
  text: string,
  authenticatedUserId: string,
  index: MemoryIndex,
  enabled: boolean,
): Promise<string> {
  if (!enabled) {
    return text;
  }
  const memories = await index.list(authenticatedUserId);
  return personalizeNudgeText(text, memories);
}

function latest(memories: MemoryRecord[], type: MemoryKind): MemoryRecord | undefined {
  return memories.filter((memory) => memory.type === type).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function readSearchQuery(req: Request): string | null {
  const fromBody = isRecord(req.body) && typeof req.body.query === "string" ? req.body.query.trim() : "";
  const fromQuery = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const query = fromBody || fromQuery;
  return query.length > 0 ? query : null;
}

function supplied(req: Request, names: string[]): string | null {
  const sources: unknown[] = [req.query, req.body, req.params];
  for (const source of sources) {
    if (!isRecord(source)) {
      continue;
    }
    for (const name of names) {
      const value = source[name];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return null;
}

function refuseMetaScope(meta: Record<string, unknown> | undefined): void {
  if (!meta) {
    return;
  }
  if ("userId" in meta || "user_id" in meta || "assistantId" in meta || "assistant_id" in meta) {
    throw new ScopeError(400, "Refusing a client-supplied user id.");
  }
}

async function ownedMemories(index: MemoryIndex, userId: string): Promise<MemoryRecord[]> {
  const memories = await index.list(userId);
  return memories.filter((memory) => memory.userId === userId);
}

function asKind(value: string): MemoryKind {
  switch (value) {
    case "regret":
    case "goal":
    case "returned":
      return value;
    default:
      return "regret";
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected memory type: ${String(value)}`);
}
