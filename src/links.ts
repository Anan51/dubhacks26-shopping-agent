const CART_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

/** Same alphabet as a cart code: no 0/O or 1/I, so it can be read aloud. */
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isCartCode(value: string): boolean {
  return CART_CODE.test(value);
}

/** The question Simmer texts when a checkout pauses. */
export const UPGRADE_PROMPT = "What's making you want to upgrade?";

export function prefilledText(code: string): string {
  return `Hey Simmer, cart ${code}`;
}

/** Opens Messages. A shared iMessage line delivers it when the recipient is the agent number. */
export function textSimmerLink(handle: string | null, code: string): string {
  return smsLink(handle, prefilledText(code));
}

/** Stable 6-character code for a shopper id. The same id always yields the same code. */
export function linkCodeForUser(userId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let rest = hash >>> 0;
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    const alphabetIndex = rest % LINK_ALPHABET.length;
    code += LINK_ALPHABET[alphabetIndex] ?? "A";
    rest = Math.floor(rest / LINK_ALPHABET.length);
  }
  return code;
}

export function isLinkCode(value: string): boolean {
  return CART_CODE.test(value.trim().toUpperCase());
}

/** What the shopper texts. A short code stands in for the full user id. */
export function linkPhoneText(userId: string): string {
  return `link ${linkCodeForUser(userId)}`;
}

/**
 * Paused-card sentence. A raw user id is never shown.
 * With no agent number, the sentence still names iMessage and omits the id.
 */
export function pausedLinkLine(linkMessage: string | null, agentHandle: string | null): string {
  const code = shownLinkCode(linkMessage);
  const number = agentHandle?.trim() ?? "";
  if (code && number) {
    return `Text link ${code} to ${number}.`;
  }
  if (code) {
    return `Text link ${code} to Simmer on iMessage.`;
  }
  if (number) {
    return `Text Simmer at ${number} to link this checkout.`;
  }
  return "Text Simmer on iMessage to link this checkout.";
}

/** Prefer a server short code. Otherwise derive one from the shopper id. */
export function linkMessageForCard(serverMessage: string | null, userId: string): string {
  const code = shownLinkCode(serverMessage);
  if (code) {
    return `link ${code}`;
  }
  return linkPhoneText(userId);
}

function shownLinkCode(linkMessage: string | null): string | null {
  if (!linkMessage) {
    return null;
  }
  const token = linkMessage.trim().replace(/^link\s+/i, "");
  if (!isLinkCode(token)) {
    return null;
  }
  return token.toUpperCase();
}

export function linkPhoneSms(handle: string | null, userId: string): string {
  return smsLink(handle, linkPhoneText(userId));
}

function smsLink(handle: string | null, body: string): string {
  return `sms:${handle?.trim() ?? ""}&body=${encodeURIComponent(body)}`;
}

export function checkoutUrl(origin: string, code: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/c/${code}`;
}

export function deskChatUrl(code: string): string {
  return `/dev?cart=${code}`;
}
