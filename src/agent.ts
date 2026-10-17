import { pathToFileURL } from "node:url";

import { ApiError } from "@photon-ai/api";
import { io, type Socket } from "socket.io-client";

import { readConfig } from "./config.js";
import { handleIncomingEvent } from "./handle-message.js";

type DeliveryMetadata = {
  seq: number;
  replyExpected: boolean;
};

type SubscribeAck = { ok: true } | { ok: false; error: { code: string } };

/**
 * Long-running live listener. No public URL.
 * Connection shape: https://photon.codes/docs/beta/websocket/example
 * `startSeq` 0 is live-only. The cursor stays in memory, so a restart does
 * not replay events that arrived while this process was down.
 */
export function startAgent(): Socket {
  const config = readConfig();
  let cursor = 0;
  let epoch = 0;
  let pending = 0;
  let queue = Promise.resolve();

  const socket = io(config.apiOrigin, {
    path: `/v1/projects/${config.projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${config.apiKey}` },
    autoConnect: false,
  });

  socket.on("connect", () => {
    console.log("Connected. Waiting for iMessage texts.");
    socket.timeout(10_000).emit("subscribe", { startSeq: cursor }, (error: unknown, result: unknown) => {
      if (error) {
        console.error(error instanceof Error ? error.message : "subscribe failed");
        socket.io.engine?.close();
        return;
      }
      if (!isSubscribeAck(result) || !result.ok) {
        console.error(isSubscribeAck(result) && !result.ok ? result.error.code : "subscribe_failed");
      }
    });
  });

  socket.on("disconnect", () => {
    epoch += 1;
  });

  socket.on("delivery", (event: unknown, metadata: DeliveryMetadata) => {
    const generation = epoch;
    pending += 1;
    if (pending > 128) {
      pending -= 1;
      epoch += 1;
      socket.io.engine?.close();
      return;
    }

    queue = queue
      .then(async () => {
        if (generation !== epoch || metadata.seq <= cursor) {
          return;
        }
        await handleDelivery(event);
        cursor = metadata.seq;
      })
      .catch((error: unknown) => {
        logFailure(error);
        if (generation === epoch) {
          epoch += 1;
          socket.io.engine?.close();
        }
      })
      .finally(() => {
        pending -= 1;
      });
  });

  socket.on("delivery_error", (error: unknown) => {
    console.error(isRecord(error) && typeof error.code === "string" ? error.code : "delivery_error");
  });
  socket.on("connect_error", (error: Error) => {
    console.error(error.message);
  });

  const shutdown = () => {
    socket.io.reconnection(false);
    socket.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  socket.connect();
  return socket;
}

async function handleDelivery(event: unknown): Promise<void> {
  const decision = await handleIncomingEvent(event);
  switch (decision.action) {
    case "reply":
      console.log(`Reply accepted for ${decision.messageId}; delivery is asynchronous.`);
      return;
    case "ignore":
      if (decision.reason !== "not-message-received") {
        console.log(`No reply (${decision.reason}).`);
      }
      return;
    default: {
      const unreachable: never = decision;
      throw new Error(`Unhandled decision: ${JSON.stringify(unreachable)}`);
    }
  }
}

function logFailure(error: unknown): void {
  if (error instanceof ApiError) {
    console.error(`Photon API error ${error.status} (request ${error.requestId ?? "unknown"}).`);
    return;
  }
  console.error(error instanceof Error ? error.message : "Event processing failed");
}

function isSubscribeAck(value: unknown): value is SubscribeAck {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return true;
  }
  return isRecord(value.error) && typeof value.error.code === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    startAgent();
  } catch (error) {
    logFailure(error);
    process.exitCode = 1;
  }
}
