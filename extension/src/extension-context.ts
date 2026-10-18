export type ExtensionRuntime = {
  id?: string;
  lastError?: { message?: string };
  sendMessage: (message: unknown, response?: (value: unknown) => void) => unknown;
};

export function extensionContextAlive(runtime: { id?: string } | null | undefined): boolean {
  try {
    return typeof runtime?.id === "string" && runtime.id.length > 0;
  } catch {
    return false;
  }
}

export function isInvalidatedContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /extension context invalidated/i.test(message);
}

/**
 * Chrome rejects the promise returned by sendMessage after a reload, even when a
 * callback is passed. Catch that, and tell the caller to drop timers and listeners.
 */
export function deliverExtensionMessage(
  runtime: ExtensionRuntime,
  payload: unknown,
  onInvalidated: () => void,
): Promise<unknown> {
  if (!extensionContextAlive(runtime)) {
    onInvalidated();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    let notified = false;
    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const notify = () => {
      if (notified) {
        return;
      }
      notified = true;
      onInvalidated();
    };
    try {
      const result = runtime.sendMessage(payload, (value) => {
        try {
          const reason = runtime.lastError?.message ?? "";
          if (isInvalidatedContextError(reason) || !extensionContextAlive(runtime)) {
            notify();
            finish(null);
            return;
          }
          if (runtime.lastError) {
            finish(null);
            return;
          }
          finish(value);
        } catch (error) {
          if (isInvalidatedContextError(error) || !extensionContextAlive(runtime)) {
            notify();
          }
          finish(null);
        }
      });
      if (isPromise(result)) {
        void result.then(
          () => undefined,
          (error: unknown) => {
            if (isInvalidatedContextError(error) || !extensionContextAlive(runtime)) {
              notify();
            }
            finish(null);
          },
        );
      }
    } catch (error) {
      if (isInvalidatedContextError(error) || !extensionContextAlive(runtime)) {
        notify();
      }
      finish(null);
    }
  });
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof (value as { then?: unknown }).then === "function";
}
