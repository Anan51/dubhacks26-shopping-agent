/** Paths the extension background may fetch. Anything else is refused. */
export function apiPathAllowed(path) {
  return path.startsWith("/api/") || path === "/purchases" || path.startsWith("/purchases/");
}

/** Bearer from chrome.storage.local `simmer_token`, plus the httpOnly cookie when the browser has it. */
export function apiRequestInit(method, token, body) {
  const headers = { accept: "application/json" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (typeof token === "string" && token.length > 0) {
    headers.authorization = `Bearer ${token}`;
  }
  return {
    method: method === "POST" ? "POST" : "GET",
    credentials: "include",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
