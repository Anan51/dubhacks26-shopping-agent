const CART_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

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

export function linkPhoneText(userId: string): string {
  return `link ${userId}`;
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
