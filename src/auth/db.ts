import mongoose from "mongoose";

export type MongoState = "not-configured" | "connecting" | "ready" | "error";

let state: MongoState = "not-configured";

export function mongoState(): MongoState {
  return state;
}

/** True only when MONGODB_URI is non-empty. The URI itself is never logged or hardcoded. */
export function mongoConfigured(uri: string | null | undefined): boolean {
  return Boolean(uri?.trim());
}

export type ConnectMongoOptions = {
  serverSelectionTimeoutMS?: number;
  dbName?: string;
};

/**
 * Connects when a URI is present. A missing URI is the normal demo path:
 * the process keeps booting and auth routes report that MongoDB is not configured.
 */
export async function connectMongo(uri: string | null, options: ConnectMongoOptions = {}): Promise<MongoState> {
  const trimmed = uri?.trim() ?? "";
  if (!mongoConfigured(trimmed)) {
    if (state !== "ready") {
      state = "not-configured";
    }
    return state;
  }
  state = "connecting";
  try {
    await mongoose.connect(trimmed, {
      ...(options.serverSelectionTimeoutMS !== undefined
        ? { serverSelectionTimeoutMS: options.serverSelectionTimeoutMS }
        : {}),
      ...(options.dbName ? { dbName: options.dbName } : {}),
    });
    state = "ready";
  } catch (error) {
    state = "error";
    throw error;
  }
  return state;
}

export function mongoUnavailableMessage(): string {
  const current = mongoState();
  switch (current) {
    case "not-configured":
      return "MongoDB is not configured.";
    case "connecting":
      return "MongoDB is still connecting.";
    case "error":
      return "MongoDB is unavailable.";
    case "ready":
      return "MongoDB is ready.";
    default: {
      const exhausted: never = current;
      return exhausted;
    }
  }
}
