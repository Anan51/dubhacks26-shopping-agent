import type { CheckInSender } from "./service.js";
import { sendDueCheckIns } from "./service.js";

export const CHECK_IN_INTERVAL_MS = 60_000;

/** Mongo holds the due time, so a restart just asks again. */
export function startCheckInLoop(
  deps: Omit<CheckInSender, "now"> & { now: () => Date; intervalMs?: number },
): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    void sendDueCheckIns({ now: deps.now(), linkFor: deps.linkFor, send: deps.send })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Check-in pass failed.");
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs ?? CHECK_IN_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
