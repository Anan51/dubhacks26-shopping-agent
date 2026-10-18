import { ApiError } from "@photon-ai/api";
import { io, type Socket } from "socket.io-client";

import type { OutboundMessage } from "../channel.js";
import type { AgentConfig } from "../config.js";
import { sendPhotonMessage } from "../photon-send.js";

type DeliveryMetadata = {
  seq: number;
  replyExpected: boolean;
};

type SubscribeAck = { ok: true } | { ok: false; error: { code: string } };

/**
 * Long-running Photon live listener. No public URL.
 * Connection shape: https://photon.codes/docs/beta/websocket/example
 * `startSeq` 0 is live-only. The cursor stays in memory, so a restart does
 * not replay events that arrived while this process was down.
 */
export class PhotonChannel {
  readonly kind = "photon" as const;
  private socket: Socket | null = null;
  private handler: ((event: unknown) => Promise<void>) | null = null;

  constructor(private readonly config: AgentConfig) {}

  onDelivery(handler: (event: unknown) => Promise<void>): void {
    this.handler = handler;
  }

  start(): void {
    let cursor = 0;
    let epoch = 0;
    let pending = 0;
    let queue = Promise.resolve();
    const socket = io(this.config.apiOrigin, {
      path: `/v1/projects/${this.config.projectId}/events/ws`,
      addTrailingSlash: false,
      transports: ["websocket"],
      extraHeaders: { Authorization: `Bearer ${this.config.apiKey}` },
      autoConnect: false,
    });
    this.socket = socket;

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
          await this.handler?.(event);
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

    socket.connect();
  }

  async stop(): Promise<void> {
    this.socket?.io.reconnection(false);
    this.socket?.close();
    this.socket = null;
  }

  async send(message: OutboundMessage): Promise<void> {
    await sendPhotonMessage(this.config, message);
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
