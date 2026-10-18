/** One signed-in fetch. A 401 clears the saved sign-in through the single handler. */
export async function authorizedFetch(
  url: string,
  init: { method?: string; body?: unknown } | undefined,
  authorization: () => Promise<string | null>,
  onUnauthorized: (token: string | null) => Promise<void>,
): Promise<Response | null> {
  const token = await authorization();
  const method = init?.method ?? "GET";
  const response = await fetch(url, {
    method,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status === 401) {
    await onUnauthorized(token);
    return null;
  }
  return response;
}
