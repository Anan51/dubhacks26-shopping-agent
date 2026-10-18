/**
 * URLs the service worker should inject the content script into.
 * Full page loads also match the manifest. Client-side navigations do not, so the worker injects on these too.
 */
export function shouldInjectContent(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (isLocalHost(host) && (isFallbackPath(path) || isLocalAmazonPath(path))) {
    return true;
  }
  if (isAppleRetail(host) && isBagPath(path)) {
    return true;
  }
  if (isSecureAppleStore(host) && (isBagPath(path) || path.includes("checkout"))) {
    return true;
  }
  if (isAmazonHost(host) && (isAmazonCart(path) || isAmazonCheckout(path) || isAmazonThanks(path))) {
    return true;
  }
  return false;
}

function isLocalHost(host) {
  return host === "127.0.0.1" || host === "localhost";
}

function isFallbackPath(path) {
  return path === "/fallback" || path.startsWith("/fallback/");
}

function isLocalAmazonPath(path) {
  return path === "/amazon" || path.startsWith("/amazon/");
}

function isAppleRetail(host) {
  return (
    host === "apple.com" ||
    host === "www.apple.com" ||
    host === "apple.com.cn" ||
    host === "www.apple.com.cn"
  );
}

function isSecureAppleStore(host) {
  return /^secure\d*\.store\.apple\.com$/.test(host);
}

function isBagPath(path) {
  return /\/shop\/bag(?:\/|$)/.test(path);
}

function isAmazonHost(host) {
  return host === "amazon.com" || host.endsWith(".amazon.com");
}

function isAmazonCart(path) {
  return /\/gp\/cart(?:\/|$)/.test(path) || /\/cart(?:\/|$)/.test(path);
}

function isAmazonCheckout(path) {
  return /\/checkout(?:\/|$)/.test(path) || /\/gp\/buy(?:\/|$)/.test(path);
}

function isAmazonThanks(path) {
  return /\/gp\/buy\/thankyou(?:\/|$)/.test(path);
}
