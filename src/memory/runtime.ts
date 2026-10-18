import type { Request } from "express";

import { mongooseDirectory, type AccountDirectory } from "../auth/accounts.js";
import { mongoState } from "../auth/db.js";
import { createBackboardClient, type BackboardClient, type MemoryKind, type MemoryRecord } from "./backboard.js";
import {
  createInMemoryIndex,
  createMongoMemoryIndex,
  getMemoriesForCurrentUser,
  personalizeNudge,
  rememberForCurrentUser,
  searchMemoriesForCurrentUser,
  type MemoryIndex,
} from "./service.js";

export type RememberInput = {
  type: MemoryKind;
  text: string;
  meta?: Record<string, unknown>;
};

export type MemoryRuntime = {
  remote: boolean;
  client: BackboardClient;
  directory: AccountDirectory;
  personalize(text: string, authenticatedUserId: string): Promise<string>;
  list(req: Request): Promise<MemoryRecord[]>;
  search(req: Request): Promise<MemoryRecord[]>;
  add(req: Request, input: RememberInput): Promise<MemoryRecord>;
};

export function createMemoryRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { client?: BackboardClient; remote?: boolean } = {},
): MemoryRuntime {
  const created = createBackboardClient(env);
  const client = options.client ?? created.client;
  const remote = options.remote ?? created.remote;
  const index: MemoryIndex = mongoState() === "ready" ? createMongoMemoryIndex() : createInMemoryIndex();
  const directory = mongooseDirectory();
  return {
    remote,
    client,
    directory,
    personalize(text, authenticatedUserId) {
      // A failed memory read must leave the verdict text unchanged.
      return personalizeNudge(text, authenticatedUserId, index, remote).catch(() => text);
    },
    list(req) {
      return getMemoriesForCurrentUser(req, index);
    },
    search(req) {
      return searchMemoriesForCurrentUser(req, { directory, client, index, remote });
    },
    add(req, input) {
      return rememberForCurrentUser(req, input, { directory, client, index, remote });
    },
  };
}
