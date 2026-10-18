import { mongooseDirectory } from "./auth/accounts.js";
import { mongoState } from "./auth/db.js";
import { takeCheckInReply } from "./checkins/service.js";
import { readAppConfig, readConfig } from "./config.js";
import { createBackboardClient } from "./memory/backboard.js";
import { polishPhrase } from "./phrase.js";
import { sendPhotonMessage } from "./photon-send.js";
import { ReminderScheduler } from "./reminders.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createDefaultStore } from "./store.js";

let cached: Runtime | undefined;

/** Standalone webhook process. The local server passes its own runtime instead. */
export function getWebhookRuntime(): Runtime {
  if (cached) {
    return cached;
  }
  const appConfig = readAppConfig();
  const photonConfig = readConfig();
  const store = createDefaultStore(appConfig.storePath);
  const now = () => new Date();
  const scheduler = new ReminderScheduler({
    store,
    origin: appConfig.origin,
    now,
    send: (message) => sendPhotonMessage(photonConfig, message),
  });
  const inner = createRuntime({
    store,
    now,
    demoReminderMs: appConfig.demoReminderMs,
    send: (message) => sendPhotonMessage(photonConfig, message),
    armReminder: (cart) => scheduler.arm(cart),
    disarmReminder: (code) => scheduler.disarm(code),
    polish: (template, action) =>
      polishPhrase(template, action, appConfig.xaiApiKey, fetch, appConfig.xaiModel, appConfig.xaiTimeoutMs),
    extract: {
      ...(appConfig.xaiApiKey ? { apiKey: appConfig.xaiApiKey } : {}),
      model: appConfig.xaiModel,
      timeoutMs: appConfig.xaiTimeoutMs,
    },
  });
  const backboard = mongoState() === "ready" ? createBackboardClient() : null;
  cached = {
    async enqueue(message) {
      if (backboard) {
        const link = store.findPhoneLinkByConversation(message.conversationId);
        const taken = await takeCheckInReply(link?.userId ?? null, message.text, {
          directory: mongooseDirectory(),
          client: backboard.client,
          remote: backboard.remote,
        });
        if (taken) {
          store.rememberInbound(message.id);
          return;
        }
      }
      await inner.enqueue(message);
    },
  };
  scheduler.armPending();
  return cached;
}
