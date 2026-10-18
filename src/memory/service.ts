import type { Request } from "express";

import type { AccountDirectory, AccountUser } from "../auth/accounts.js";
import { MemoryNote } from "../auth/user.js";
import {
  waitForMemoryWrite,
  type BackboardClient,
  type MemoryKind,
  type MemoryRecord,
} from "./backboard.js";

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

export type MemoryIndex = {
  insert(record: MemoryRecord): Promise<MemoryRecord>;
  list(userId: string): Promise<MemoryRecord[]>;
};

const ASSISTANT_PROMPT = "You remember one shopper's regrets, goals, and items they returned. Do not invent purchases.";

/**
 * Retrieval is scoped to the authenticated user's Mongo _id on req.user.
 * Query, body, route params, and metadata ids are ignored as a source of identity.
 * A different user id, or any assistant id, is refused before the index is touched.
 */
export async function getMemoriesForCurrentUser(req: Request, index: MemoryIndex): Promise<MemoryRecord[]> {
  const userId = authenticatedUserId(req);
  refuseClientScope(req, userId);
  return index.list(userId);
}

export function authenticatedUserId(req: Request): string {
  const id = req.user?.id?.trim() ?? "";
  if (!id) {
    throw new ScopeError("Authentication required.");
  }
  return id;
}

export function refuseClientScope(req: Request, userId: string): void {
  if (supplied(req, ["assistantId", "assistant_id"])) {
    throw new ScopeError("Refusing a client-supplied assistant id.");
  }
  const requestedUser = supplied(req, ["userId", "user_id"]);
  if (requestedUser && requestedUser !== userId) {
    throw new ScopeError("Refusing a client-supplied user id.");
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
    throw new ScopeError("Authentication required.");
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

/**
 * Creates the user's own assistant when they do not have one yet.
 * The id is stored on that Mongo user. There is no argument for a client-supplied assistant id.
 */
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

export function memoryContent(type: MemoryKind, text: string): string {
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
        meta: isMeta(doc.meta) ? doc.meta : {},
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
        meta: isMeta(doc.meta) ? doc.meta : {},
        backboardMemoryId: doc.backboardMemoryId ?? null,
      }));
    },
  };
}

export function personalizeNudgeText(base: string, memories: MemoryRecord[]): string {
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

/**
 * No-op unless Backboard is configured. Reads the local index for this Mongo user.
 * It does not call POST /threads/messages, so a nudge does not spend the gpt-4o credit.
 */
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
    throw new ScopeError("Refusing a client-supplied user id.");
  }
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

function isMeta(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected memory type: ${String(value)}`);
}
