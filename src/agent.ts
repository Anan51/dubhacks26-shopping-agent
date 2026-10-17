import { pathToFileURL } from "node:url";

import { startServer } from "./server.js";

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "WaitMate failed to start.");
    process.exitCode = 1;
  });
}
