import type { Request } from "express";

import type { AccountDirectory, AccountUser } from "../auth/accounts.js";
import { MemoryNote } from "../auth/user.js";
import { isRecord } from "../record.js";
import { regretSearchMaxDistance, withinMaxDistance } from "../scoring/backboardScore.js";
import {
  waitForMemoryWrite,
  type BackboardClient,
  type MemoryKind,
  type MemoryRecord,
  type MemorySearchHit,
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
  const maxDistance = regretSearchMaxDistance();
  const user = await deps.directory.findById(userId);
  if (!user) {
    throw new ScopeError(401, "Authentication required.");
  }
  const owned = await ownedMemories(deps.index, userId);
  // An empty search is the caller's full list. Still only rows from ownedMemories.
  if (!query) {
    return owned;
  }
  // Backboard hits have no Simmer user id. Rank only Mongo rows owned by req.user.id.
  // Hits past the distance cutoff, or hits that match none of those rows, fall through to the token scan.
  if (deps.remote && user.backboardAssistantId) {
    const hits = await deps.client.searchMemories(user.backboardAssistantId, query, 10);
    const ranked = rankOwnedByHits(owned, hits, maxDistance);
    if (ranked !== null && ranked.length > 0) {
      return ranked;
    }
  }
  return owned.filter((memory) => matchesAnyQueryToken(memory, query));
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

/** Null when no close hit has an id or content, so the caller can fall back to tokens. */
function rankOwnedByHits(
  owned: readonly MemoryRecord[],
  hits: readonly MemorySearchHit[],
  maxDistance: number,
): MemoryRecord[] | null {
  const usable = hits.filter((hit) => {
    const identifiable = (hit.id?.trim() ?? "").length > 0 || hit.content.trim().length > 0;
    return identifiable && withinMaxDistance(hit.score, maxDistance);
  });
  if (usable.length === 0) {
    return null;
  }
  const used = new Set<number>();
  const ranked: MemoryRecord[] = [];
  for (const hit of usable) {
    const index = ownedIndexForHit(owned, used, hit);
    if (index < 0) {
      continue;
    }
    const match = owned[index];
    if (!match) {
      continue;
    }
    used.add(index);
    ranked.push(match);
  }
  return ranked;
}

function ownedIndexForHit(owned: readonly MemoryRecord[], used: ReadonlySet<number>, hit: MemorySearchHit): number {
  const byId = owned.findIndex((memory, index) => !used.has(index) && sameBackboardId(hit.id, memory.backboardMemoryId));
  if (byId !== -1) {
    return byId;
  }
  // A hit that carries an id but matched no owned row above is not one of the caller's
  // rows. Identical content from another user's memory must not pull the row in by text.
  if ((hit.id?.trim() ?? "").length > 0) {
    return -1;
  }
  const content = hit.content.trim().toLowerCase();
  if (!content) {
    return -1;
  }
  return owned.findIndex((memory, index) => {
    if (used.has(index)) {
      return false;
    }
    return memoryContent(memory.type, memory.text).trim().toLowerCase() === content;
  });
}

function sameBackboardId(hitId: string | null, memoryId: string | null): boolean {
  const left = hitId?.trim() ?? "";
  const right = memoryId?.trim() ?? "";
  return left.length > 0 && left === right;
}

const QUERY_TOKEN_STOPWORDS = new Set(["my", "to", "an", "of", "in", "on", "at", "by", "or", "the", "a"]);

function matchesAnyQueryToken(memory: MemoryRecord, query: string): boolean {
  const haystack = memoryContent(memory.type, memory.text).toLowerCase();
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // One-letter pieces ("a" in "secret-regret-from-a") and other tokens shorter than 3
    // characters match inside unrelated words. The same is true of short filler such as "the".
    .filter((token) => token.length >= 3 && !QUERY_TOKEN_STOPWORDS.has(token))
    .some((token) => haystack.includes(token));
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
