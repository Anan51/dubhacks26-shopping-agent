export type ApplePage = "bag" | "checkout";

const RETAIL_HOSTS = new Set(["apple.com", "www.apple.com", "apple.com.cn", "www.apple.com.cn"]);

/** Bag and Apple checkout URLs, including regional store paths on www.apple.com. */
export function applePage(url: string): ApplePage | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (isCheckoutHost(host) && path.includes("checkout")) {
    return "checkout";
  }
  if (RETAIL_HOSTS.has(host) && /\/shop\/bag(?:\/|$)/.test(path)) {
    return "bag";
  }
  if (isLocalFallback(host, path)) {
    return "bag";
  }
  return null;
}

export function shouldEngage(url: string, optedOutHosts: readonly string[]): boolean {
  if (!applePage(url)) {
    return false;
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return !hostOptedOut(host, optedOutHosts);
}

export function hostOptedOut(hostname: string, optedOutHosts: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  return optedOutHosts.some((entry) => {
    const opted = normalizeHost(entry);
    if (!opted) {
      return false;
    }
    if (host === opted || host.endsWith(`.${opted}`)) {
      return true;
    }
    if (opted === "apple.com" && isAppleFamily(host)) {
      return true;
    }
    return false;
  });
}

export function isFallbackBag(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  return isLocalFallback(host, path) || isLocalAmazonPath(host, path);
}

/** Local Amazon cart fixture. Not an Apple bag, and not a live amazon.com page. */
export function isLocalAmazonFixture(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return isLocalAmazonPath(parsed.hostname.toLowerCase(), parsed.pathname.toLowerCase());
}

function isLocalFallback(host: string, path: string): boolean {
  return (host === "127.0.0.1" || host === "localhost") && (path === "/fallback" || path.startsWith("/fallback/"));
}

function isLocalAmazonPath(host: string, path: string): boolean {
  return (host === "127.0.0.1" || host === "localhost") && (path === "/amazon" || path.startsWith("/amazon/"));
}

function isCheckoutHost(host: string): boolean {
  return /^secure\d*\.store\.apple\.com$/.test(host);
}

function isAppleFamily(host: string): boolean {
  return host === "apple.com" || host.endsWith(".apple.com") || host.endsWith(".store.apple.com");
}

function normalizeHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}
