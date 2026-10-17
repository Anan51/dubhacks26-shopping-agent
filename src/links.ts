const CART_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

export function isCartCode(value: string): boolean {
  return CART_CODE.test(value);
}

export function prefilledText(code: string): string {
  return `Hey WaitMate, cart ${code}`;
}

/** Opens Messages. A shared iMessage line delivers it when the recipient is the agent number. */
export function textWaitMateLink(handle: string, code: string): string {
  const body = encodeURIComponent(prefilledText(code));
  return `sms:${handle.trim()}&body=${body}`;
}

export function checkoutUrl(origin: string, code: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/c/${code}`;
}

export function deskChatUrl(code: string): string {
  return `/dev?cart=${code}`;
}
