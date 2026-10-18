import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import express from "express";
import { createServer as createViteServer } from "vite";

import { createApp } from "./app.js";
import { PhotonChannel } from "./channels/photon.js";
import { photonConfigured, readAppConfig, readConfig } from "./config.js";
import { createDefaultStore } from "./store.js";

const webRoot = path.join(process.cwd(), "web");

function loadEnvFile(): void {
  const file = path.join(process.cwd(), ".env");
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export async function startServer(): Promise<void> {
  loadEnvFile();
  const appConfig = readAppConfig();
  const wantPhoton = appConfig.channel === "photon" || (appConfig.channel === "auto" && photonConfigured());
  if (appConfig.channel === "photon" && !photonConfigured()) {
    throw new Error(
      "WAITMATE_CHANNEL=photon needs PHOTON_API_KEY, PHOTON_PROJECT_ID, PHOTON_PLATFORM, and PHOTON_AGENT_HANDLE.",
    );
  }

  const photon = wantPhoton ? new PhotonChannel(readConfig()) : null;
  const running = createApp({
    store: createDefaultStore(appConfig.storePath ? path.resolve(appConfig.storePath) : null),
    origin: appConfig.origin,
    coolingMs: appConfig.coolingMs,
    lockThresholdCents: appConfig.lockThresholdCents,
    demoReminderMs: appConfig.demoReminderMs,
    demoDefault: appConfig.demoDefault,
    agentHandle: appConfig.agentHandle,
    photon,
    ...(appConfig.xaiApiKey ? { xaiApiKey: appConfig.xaiApiKey } : {}),
    xaiModel: appConfig.xaiModel,
    xaiTimeoutMs: appConfig.xaiTimeoutMs,
  });

  await attachClient(running.app);
  if (photon) {
    photon.start();
  }
  running.scheduler.armPending();

  const server = createServer(running.app);
  server.listen(appConfig.port, () => {
    console.log(`WaitMate listening on ${appConfig.origin}`);
    console.log(photon ? "Photon live connection is starting." : "Desk chat is standing in for Photon. No API key needed.");
  });

  const shutdown = () => {
    photon?.stop().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Photon shutdown failed.");
    });
    running.scheduler.stop();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function attachClient(app: express.Express): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    const dist = path.join(webRoot, "dist");
    const indexHtml = path.join(dist, "index.html");
    if (!existsSync(indexHtml)) {
      console.error("web/dist is missing. Run npm run build before npm start.");
      return;
    }
    app.use(express.static(dist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });
    return;
  }

  const vite = await createViteServer({
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "WaitMate failed to start.");
    process.exitCode = 1;
  });
}
