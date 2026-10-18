const STORAGE_KEY = "waitmate-guard-session";

export function guardSessionId(): string {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing && /^guard:[A-Za-z0-9-]{8,80}$/.test(existing)) {
    return existing;
  }
  const created = `guard:${crypto.randomUUID()}`;
  window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}
