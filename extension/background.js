const DEFAULT_ORIGIN = "http://127.0.0.1:4321";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "simmer") {
    return undefined;
  }
  if (message.action === "settings") {
    chrome.storage.local.get(["simmerOrigin", "simmerOptOut", "simmerUserId", "simmerCartCode"], (items) => {
      let userId = typeof items.simmerUserId === "string" ? items.simmerUserId : "";
      if (!/^user-[a-z0-9-]{8,64}$/i.test(userId)) {
        userId = `user-${crypto.randomUUID()}`;
        chrome.storage.local.set({ simmerUserId: userId });
      }
      sendResponse({
        origin: allowedOrigin(items.simmerOrigin) ?? DEFAULT_ORIGIN,
        optOut: Array.isArray(items.simmerOptOut) ? items.simmerOptOut.filter((item) => typeof item === "string") : [],
        userId,
        cartCode: typeof items.simmerCartCode === "string" ? items.simmerCartCode : "",
      });
    });
    return true;
  }
  if (message.action === "remember-cart") {
    const code = typeof message.code === "string" ? message.code : "";
    chrome.storage.local.set({ simmerCartCode: code }, () => sendResponse({ ok: true }));
    return true;
  }
  if (message.action === "api") {
    chrome.storage.local.get(["simmerOrigin"], (items) => {
      const origin = allowedOrigin(items.simmerOrigin) ?? DEFAULT_ORIGIN;
      const path = typeof message.path === "string" ? message.path : "";
      if (!path.startsWith("/api/")) {
        sendResponse({ ok: false, error: "Bad path." });
        return;
      }
      fetch(`${origin}${path}`, {
        method: message.method === "POST" ? "POST" : "GET",
        headers: {
          accept: "application/json",
          ...(message.body ? { "content-type": "application/json" } : {}),
        },
        body: message.body ? JSON.stringify(message.body) : undefined,
      })
        .then(async (response) => {
          const body = await response.json();
          sendResponse({ ok: response.ok, status: response.status, body });
        })
        .catch((error) => {
          sendResponse({ ok: false, status: 0, error: error instanceof Error ? error.message : "Network error" });
        });
    });
    return true;
  }
  return undefined;
});

function allowedOrigin(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return null;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
