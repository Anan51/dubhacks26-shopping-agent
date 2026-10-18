export const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";

/** Fast default when XAI_MODEL is empty. */
export const DEFAULT_XAI_MODEL = "grok-4-fast";

export function xaiModelFrom(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XAI_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_XAI_MODEL;
}

type ChatCompletion = {
  choices?: { message?: { content?: string } }[];
};

/** One chat completion. Returns the assistant text, or null on failure. Never logs the key. */
export async function grokChat(input: {
  apiKey: string;
  model: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(XAI_CHAT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }],
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as ChatCompletion;
    const text = body.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
