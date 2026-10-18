import type { IncomingMessage, ServerResponse } from "node:http";

import { ApiError } from "@photon-ai/api";

import { readConfig } from "../src/config.js";
import { handleIncomingEvent } from "../src/handle-message.js";
import type { Runtime } from "../src/runtime.js";
import { getWebhookRuntime } from "../src/webhook-runtime.js";

const MAX_BODY_BYTES = 1_000_000;

class PayloadTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "PayloadTooLargeError";
  }
}

type WebhookRequest = IncomingMessage & {
  /** Set when the platform already parsed the JSON body. */
  body?: unknown;
};

/**
 * Keep the raw bytes. Signature verification has to hash the exact body Photon
 * sent, and a JSON parser would change whitespace.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Vercel route: POST /api/webhook
 *
 * TODO(photon-beta): verify the webhook signature before trusting the body.
 * Creating a destination returns `signingSecret` (`whsec_...`) once and says to
 * store it for signature verification, but the Beta docs and OpenAPI spec do
 * not name the header or the algorithm:
 * https://photon.codes/docs/beta/api-client/sdk/projects/create-webhook-destination
 * https://api.photon.codes/openapi.json
 * Stable Spectrum's `X-Spectrum-Signature` scheme is a different product. Do
 * not reuse it here. Until the Beta scheme is documented, a configured secret
 * is required so an empty deploy fails closed, and then the body is accepted
 * unverified. Treat the deployment URL as a secret until this TODO is done.
 */
export default async function handler(req: WebhookRequest, res: ServerResponse): Promise<void> {
  await handleWebhook(req, res);
}

export async function handleWebhook(req: WebhookRequest, res: ServerResponse, runtime?: Runtime): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const secret = process.env.PHOTON_WEBHOOK_SECRET?.trim();
  if (!secret) {
    sendJson(res, 500, { error: "Missing PHOTON_WEBHOOK_SECRET." });
    return;
  }
  if (!secret.startsWith("whsec_")) {
    sendJson(res, 500, { error: "PHOTON_WEBHOOK_SECRET must be the whsec_ destination secret." });
    return;
  }

  let event: unknown;
  try {
    event = await readEvent(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: "body too large" });
      return;
    }
    sendJson(res, 400, { error: "invalid json" });
    return;
  }

  try {
    const decision = await handleIncomingEvent(event, runtime ?? getWebhookRuntime(), readConfig());
    sendJson(res, 200, { ok: true, action: decision.action });
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`Photon API error ${error.status} (request ${error.requestId ?? "unknown"}).`);
    } else {
      console.error(error instanceof Error ? error.message : "webhook failed");
    }
    sendJson(res, 500, { error: "failed to handle event" });
  }
}

async function readEvent(req: WebhookRequest): Promise<unknown> {
  if (typeof req.body === "string" && req.body.length > 0) {
    return JSON.parse(req.body) as unknown;
  }
  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8")) as unknown;
  }
  if (isParsedJsonBody(req.body)) {
    return req.body;
  }

  const rawBody = await readRawBody(req);
  return JSON.parse(rawBody) as unknown;
}

function isParsedJsonBody(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) && !Buffer.isBuffer(body);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}
