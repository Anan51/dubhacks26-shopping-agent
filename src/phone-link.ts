import { toDataURL } from "qrcode";

import { formatUsd } from "./format.js";
import { prefilledText, textSimmerLink, UPGRADE_PROMPT } from "./links.js";
import type { PhoneLink, Store } from "./store.js";
import type { Cart, CheckoutPing } from "./types.js";

const USER_ID = /^[A-Za-z0-9:_-]{4,80}$/;

export function parseLinkCommand(text: string): { userId: string | null } | null {
  const match = text.trim().match(/^link(?:\s+([A-Za-z0-9:_-]{4,80}))?\s*$/i);
  const userId = match?.[1];
  if (!match) {
    return null;
  }
  if (userId && !USER_ID.test(userId)) {
    return null;
  }
  return { userId: userId ?? null };
}

export function isUserId(value: string): boolean {
  return USER_ID.test(value);
}

export function threadUserId(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 64);
  return `thread:${safe}`.slice(0, 80);
}

export function checkoutPingText(cart: Cart): string {
  return `Simmer paused your ${formatUsd(cart.totalCents)} checkout. Cart ${cart.code}. ${UPGRADE_PROMPT}`;
}

export async function notifyCheckout(input: {
  store: Store;
  cart: Cart;
  agentHandle: string | null;
  fail: boolean;
  now: Date;
  send: (link: PhoneLink, text: string) => Promise<void>;
  qr?: (text: string) => Promise<string>;
}): Promise<CheckoutPing> {
  const prefilled = prefilledText(input.cart.code);
  const smsLink = textSimmerLink(input.agentHandle, input.cart.code);
  const userId = input.cart.userId;
  const link = userId ? input.store.getPhoneLink(userId) : undefined;
  if (!link || input.fail) {
    return {
      delivered: false,
      reason: link ? "send_failed" : "unlinked",
      smsLink,
      qrDataUrl: await qrFor(smsLink, input.qr),
      prefilled,
    };
  }
  try {
    await input.send(link, checkoutPingText(input.cart));
  } catch {
    return {
      delivered: false,
      reason: "send_failed",
      smsLink,
      qrDataUrl: await qrFor(smsLink, input.qr),
      prefilled,
    };
  }
  return { delivered: true, reason: null, smsLink: null, qrDataUrl: null, prefilled };
}

async function qrFor(text: string, qr: ((text: string) => Promise<string>) | undefined): Promise<string> {
  if (qr) {
    return qr(text);
  }
  return toDataURL(text, { margin: 1, width: 180 });
}
