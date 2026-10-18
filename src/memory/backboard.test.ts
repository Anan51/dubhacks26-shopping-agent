import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBackboardClient, HttpBackboardClient, waitForMemoryWrite } from "./backboard.js";

describe("Backboard client", () => {
  it("uses the in-memory fallback when the API key is unset", async () => {
    let called = false;
    const { client, remote } = createBackboardClient({}, async () => {
      called = true;
      return new Response("{}", { status: 500 });
    });
    assert.equal(remote, false);
    const assistant = await client.createAssistant({ name: "Simmer", systemPrompt: "Remember one shopper." });
    const write = await client.addMemory(assistant.assistantId, { content: "Goal: wait a month" });
    assert.equal(write.status, "COMPLETED");
    assert.equal(called, false);
  });

  it("sends X-API-Key, pins the assistant, and polls an in-progress write", async () => {
    const requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
    let polls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      requests.push({ url, method: init?.method ?? "GET", headers, body: raw });
      if (url.endsWith("/assistants") && init?.method === "POST") {
        return json({ assistant_id: "asst-1" });
      }
      if (url.endsWith("/memories") && init?.method === "POST") {
        return json({ memory_id: null, memory_operation_id: "op-1", status: "IN_PROGRESS" }, 201);
      }
      if (url.endsWith("/operations/op-1")) {
        polls += 1;
        return json({ operation_id: "op-1", status: polls < 2 ? "IN_PROGRESS" : "COMPLETED", memory_ids: ["mem-1"] });
      }
      if (url.endsWith("/memories/search")) {
        return json({ memories: [{ id: "mem-1", content: "Goal: wait", score: 0.9, created_at: "2026-01-01T00:00:00Z" }], total_count: 1 });
      }
      if (url.endsWith("/threads/messages")) {
        return json({ content: "Noted.", thread_id: "thread-1", memory_operation_id: null });
      }
      return json({});
    };

    const client = new HttpBackboardClient({
      baseUrl: "https://app.backboard.io/api",
      apiKey: "placeholder",
      fetchImpl,
    });
    const created = await client.createAssistant({ name: "Simmer user", systemPrompt: "Remember one shopper." });
    assert.equal(created.assistantId, "asst-1");
    const write = await client.addMemory("asst-1", { content: "Goal: wait", metadata: { type: "goal" } });
    const settled = await waitForMemoryWrite(client, write, async () => undefined);
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.memoryId, "mem-1");
    const hits = await client.searchMemories("asst-1", "wait", 5);
    assert.equal(hits[0]?.content, "Goal: wait");
    await client.sendMessage({ content: "What did I want?", assistantId: "asst-1" });

    assert.equal(requests.every((request) => request.headers.get("x-api-key") === "placeholder"), true);
    assert.equal(requests.every((request) => request.headers.get("authorization") === null), true);
    const message = requests.find((request) => request.url.endsWith("/threads/messages"));
    assert.deepEqual(message?.body, {
      content: "What did I want?",
      assistant_id: "asst-1",
      memory: "Auto",
      stream: false,
      llm_provider: "openai",
      model_name: "gpt-4o",
    });
    const search = requests.find((request) => request.url.endsWith("/memories/search"));
    assert.equal(search?.url, "https://app.backboard.io/api/assistants/asst-1/memories/search");
    assert.deepEqual(search?.body, { query: "wait", limit: 5 });
  });

  it("defaults the base URL when only the key is set", async () => {
    const urls: string[] = [];
    const { remote, client } = createBackboardClient({ BACKBOARD_API_KEY: "placeholder" }, async (input) => {
      urls.push(String(input));
      return json({ assistant_id: "asst-9" });
    });
    assert.equal(remote, true);
    await client.createAssistant({ name: "Simmer", systemPrompt: "Remember one shopper." });
    assert.equal(urls[0], "https://app.backboard.io/api/assistants");
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
