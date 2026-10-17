import { readAppConfig, readConfig } from "./config.js";
import { polishPhrase } from "./phrase.js";
import { sendPhotonMessage } from "./photon-send.js";
import { ReminderScheduler } from "./reminders.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createFileStore } from "./store.js";

let cached: Runtime | undefined;

/** Standalone webhook process. The local server passes its own runtime instead. */
export function getWebhookRuntime(): Runtime {
  if (cached) {
    return cached;
  }
  const appConfig = readAppConfig();
  const photonConfig = readConfig();
  const store = createFileStore(appConfig.storePath);
  const now = () => new Date();
  const scheduler = new ReminderScheduler({
    store,
    origin: appConfig.origin,
    now,
    send: (message) => sendPhotonMessage(photonConfig, message),
  });
  cached = createRuntime({
    store,
    now,
    demoReminderMs: appConfig.demoReminderMs,
    send: (message) => sendPhotonMessage(photonConfig, message),
    armReminder: (cart) => scheduler.arm(cart),
    disarmReminder: (code) => scheduler.disarm(code),
    polish: (template, action) => polishPhrase(template, action, appConfig.geminiApiKey, appConfig.geminiModel),
  });
  scheduler.armPending();
  return cached;
}
