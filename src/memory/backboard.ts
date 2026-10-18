import { setTimeout as delay } from "node:timers/promises";

/**
 * Backboard client.
 *
 * Confirmed from https://app.backboard.io/api and docs.backboard.io:
 * - Every request sends `X-API-Key`. Not `Authorization: Bearer`.
 * - POST /assistants { name, system_prompt } → { assistant_id }
 * - POST /assistants/{assistant_id}/memories { content, metadata? }
 * - GET /assistants/memories/operations/{operation_id} → { status: COMPLETED | IN_PROGRESS | ERROR }
 * - POST /assistants/{assistant_id}/memories/search { query, limit }
 *   The SDK's `searchMemories(assistantId, query, k)` maps `k` to this `limit`.
 * - POST /threads/messages { content, assistant_id, memory: "Auto", stream: false }
 *   Omitting assistant_id creates a new empty assistant. Always pass the per-user assistant.
 *   Documented model default is gpt-4o (`model_name`). Assistant create does not take a model.
 * - DELETE /assistants/{assistant_id}/memories
 *
 * UNCONFIRMED: whether BACKBOARD_API_KEY has a required prefix. Docs show the raw key.
 * This client sends the env value unchanged and does not add "Bearer" or any other prefix.
 *
 * The add-memory 201 body is an open object in the published OpenAPI schema. We read
 * `memory_id`, `memory_operation_id`, and `status` from the integration contract.
 *
 * Memory is scoped to an assistant, not a user. Callers must pass the assistant id stored
 * on the authenticated user's Mongo document. This class does not accept a Simmer user id.
 */

export const DEFAULT_BACKBOARD_API_URL = "https://app.backboard.io/api";
export const BACKBOARD_MODEL = "gpt-4o";

export type MemoryKind = "regret" | "goal" | "returned";

export type MemoryRecord = {
  userId: string;
  type: MemoryKind;
  text: string;
  createdAt: string;
  meta: Record<string, unknown>;
  backboardMemoryId: string | null;
};

export type MemoryOperationStatus = "COMPLETED" | "IN_PROGRESS" | "ERROR";

export type MemoryWrite = {
  memoryId: string | null;
  operationId: string | null;
  status: MemoryOperationStatus;
};

export type MemorySearchHit = {
  id: string | null;
  content: string;
  score: number | null;
  createdAt: string | null;
};

export type BackboardClient = {
  createAssistant(input: { name: string; systemPrompt: string }): Promise<{ assistantId: string }>;
  addMemory(assistantId: string, input: { content: string; metadata?: Record<string, unknown> }): Promise<MemoryWrite>;
  getMemoryOperation(operationId: string): Promise<{ status: MemoryOperationStatus; memoryIds: string[] }>;
  searchMemories(assistantId: string, query: string, limit: number): Promise<MemorySearchHit[]>;
  sendMessage(input: { content: string; assistantId: string }): Promise<{ content: string; memoryOperationId: string | null }>;
  resetMemories(assistantId: string): Promise<void>;
};

type FetchImpl = typeof fetch;

export function createBackboardClient(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchImpl = fetch): {
  client: BackboardClient;
  remote: boolean;
} {
  const apiKey = env.BACKBOARD_API_KEY?.trim() ?? "";
  if (!apiKey) {
    return { client: new InMemoryBackboardClient(), remote: false };
  }
  const baseUrl = env.BACKBOARD_API_URL?.trim() || DEFAULT_BACKBOARD_API_URL;
  return { client: new HttpBackboardClient({ baseUrl, apiKey, fetchImpl }), remote: true };
}

export class HttpBackboardClient implements BackboardClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: { baseUrl: string; apiKey: string; fetchImpl?: FetchImpl }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createAssistant(input: { name: string; systemPrompt: string }): Promise<{ assistantId: string }> {
    const body = await this.request("POST", "/assistants", {
      name: input.name,
      system_prompt: input.systemPrompt,
    });
    return { assistantId: requiredString(body, "assistant_id") };
  }

  async addMemory(assistantId: string, input: { content: string; metadata?: Record<string, unknown> }): Promise<MemoryWrite> {
    requireAssistant(assistantId);
    const body = await this.request("POST", `/assistants/${encodeURIComponent(assistantId)}/memories`, {
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return readMemoryWrite(body);
  }

  async getMemoryOperation(operationId: string): Promise<{ status: MemoryOperationStatus; memoryIds: string[] }> {
    const body = await this.request("GET", `/assistants/memories/operations/${encodeURIComponent(operationId)}`);
    const status = readStatus(body);
    if (!status) {
      throw new Error("Backboard operation response missing status.");
    }
    const memoryIds = Array.isArray(isRecord(body) ? body.memory_ids : null)
      ? (body as { memory_ids: unknown[] }).memory_ids.filter((id): id is string => typeof id === "string")
      : [];
    return { status, memoryIds };
  }

  async searchMemories(assistantId: string, query: string, limit: number): Promise<MemorySearchHit[]> {
    requireAssistant(assistantId);
    const body = await this.request("POST", `/assistants/${encodeURIComponent(assistantId)}/memories/search`, {
      query,
      limit,
    });
    const memories = isRecord(body) && Array.isArray(body.memories) ? body.memories : [];
    return memories.map((hit) => readSearchHit(hit));
  }

  async sendMessage(input: { content: string; assistantId: string }): Promise<{ content: string; memoryOperationId: string | null }> {
    requireAssistant(input.assistantId);
    const body = await this.request("POST", "/threads/messages", {
      content: input.content,
      assistant_id: input.assistantId,
      memory: "Auto",
      stream: false,
      llm_provider: "openai",
      model_name: BACKBOARD_MODEL,
    });
    const content = isRecord(body) && typeof body.content === "string" ? body.content : "";
    const memoryOperationId = isRecord(body) && typeof body.memory_operation_id === "string" ? body.memory_operation_id : null;
    return { content, memoryOperationId };
  }

  async resetMemories(assistantId: string): Promise<void> {
    requireAssistant(assistantId);
    await this.request("DELETE", `/assistants/${encodeURIComponent(assistantId)}/memories`);
  }

  private async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
    };
    const init: RequestInit = { method, headers };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(payload);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Backboard ${method} ${path} failed (${response.status}).`);
    }
    if (response.status === 204) {
      return {};
    }
    const text = await response.text();
    if (!text) {
      return {};
    }
    return JSON.parse(text) as unknown;
  }
}

type StoredMemory = {
  id: string;
  assistantId: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

/** Used when BACKBOARD_API_KEY is unset. Keeps the process booting with no network calls. */
export class InMemoryBackboardClient implements BackboardClient {
  private assistants = new Map<string, { name: string; systemPrompt: string }>();
  private memories = new Map<string, StoredMemory[]>();
  private sequence = 0;

  async createAssistant(input: { name: string; systemPrompt: string }): Promise<{ assistantId: string }> {
    const assistantId = `local-${++this.sequence}`;
    this.assistants.set(assistantId, input);
    this.memories.set(assistantId, []);
    return { assistantId };
  }

  async addMemory(assistantId: string, input: { content: string; metadata?: Record<string, unknown> }): Promise<MemoryWrite> {
    requireAssistant(assistantId);
    this.requireKnown(assistantId);
    const memoryId = `local-mem-${++this.sequence}`;
    const list = this.memories.get(assistantId) ?? [];
    list.push({
      id: memoryId,
      assistantId,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    });
    this.memories.set(assistantId, list);
    return { memoryId, operationId: null, status: "COMPLETED" };
  }

  async getMemoryOperation(): Promise<{ status: MemoryOperationStatus; memoryIds: string[] }> {
    return { status: "COMPLETED", memoryIds: [] };
  }

  async searchMemories(assistantId: string, query: string, limit: number): Promise<MemorySearchHit[]> {
    requireAssistant(assistantId);
    const needle = query.toLowerCase();
    const hits = (this.memories.get(assistantId) ?? [])
      .filter((memory) => memory.content.toLowerCase().includes(needle))
      .slice(0, limit);
    return hits.map((memory) => ({
      id: memory.id,
      content: memory.content,
      score: null,
      createdAt: memory.createdAt,
    }));
  }

  async sendMessage(input: { content: string; assistantId: string }): Promise<{ content: string; memoryOperationId: string | null }> {
    requireAssistant(input.assistantId);
    this.requireKnown(input.assistantId);
    return { content: input.content, memoryOperationId: null };
  }

  async resetMemories(assistantId: string): Promise<void> {
    requireAssistant(assistantId);
    this.memories.set(assistantId, []);
  }

  private requireKnown(assistantId: string): void {
    if (!this.assistants.has(assistantId)) {
      throw new Error("Unknown local assistant. Refusing to create one implicitly.");
    }
  }
}

const POLL_DELAYS_MS = [150, 300, 600, 1_200];

/** Polls until the write is COMPLETED or ERROR. Recall must wait on this. */
export async function waitForMemoryWrite(
  client: BackboardClient,
  write: MemoryWrite,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<MemoryWrite> {
  if (write.status !== "IN_PROGRESS" || !write.operationId) {
    return write;
  }
  let current = write;
  for (const ms of POLL_DELAYS_MS) {
    await sleep(ms);
    const polled = await client.getMemoryOperation(write.operationId);
    current = {
      memoryId: current.memoryId ?? polled.memoryIds[0] ?? null,
      operationId: write.operationId,
      status: polled.status,
    };
    if (polled.status !== "IN_PROGRESS") {
      return current;
    }
  }
  return current;
}

function requireAssistant(assistantId: string): void {
  if (!assistantId.trim()) {
    throw new Error("assistant_id is required. Omitting it would create an empty shared assistant.");
  }
}

function readMemoryWrite(body: unknown): MemoryWrite {
  if (!isRecord(body)) {
    throw new Error("Backboard memory response was not an object.");
  }
  const memoryId = typeof body.memory_id === "string" ? body.memory_id : null;
  const operationId = typeof body.memory_operation_id === "string" ? body.memory_operation_id : null;
  const status = readStatus(body) ?? (memoryId ? "COMPLETED" : operationId ? "IN_PROGRESS" : null);
  if (!status) {
    throw new Error("Backboard memory response missing status.");
  }
  return { memoryId, operationId, status };
}

function readStatus(body: unknown): MemoryOperationStatus | null {
  if (!isRecord(body) || typeof body.status !== "string") {
    return null;
  }
  switch (body.status) {
    case "COMPLETED":
    case "IN_PROGRESS":
    case "ERROR":
      return body.status;
    default:
      return null;
  }
}

function readSearchHit(value: unknown): MemorySearchHit {
  if (!isRecord(value) || typeof value.content !== "string") {
    return { id: null, content: "", score: null, createdAt: null };
  }
  return {
    id: typeof value.id === "string" ? value.id : null,
    content: value.content,
    score: typeof value.score === "number" ? value.score : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
  };
}

function requiredString(body: unknown, key: string): string {
  if (!isRecord(body)) {
    throw new Error(`Backboard response missing ${key}.`);
  }
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Backboard response missing ${key}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
