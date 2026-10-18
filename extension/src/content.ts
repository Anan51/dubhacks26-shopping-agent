import css from "./overlay.css?inline";

import { applePage, hostOptedOut, isFallbackBag } from "../../src/sites.js";
import { bagContentKey, bagParseKey, bagReadAction, watchBagDom, type BagWatch, type PageBag } from "./bag-dom.js";
import { bindCheckoutClicks } from "./checkout-record.js";
import { deliverExtensionMessage, extensionContextAlive } from "./extension-context.js";
import { installGate } from "./gate.js";
import { buttonsToBlock } from "./overlay/block.js";
import { mountSimmerCard } from "./overlay/mount.js";
import { watchPage, type PageWatch } from "./page-observer.js";
import type { OverlayModel } from "./overlay.js";
import { readActiveBag } from "./store-bag.js";
import { adapterFor } from "./stores/index.js";
import type { StoreAdapter } from "./stores/adapter.js";

let onContextDead = (): void => undefined;

type Settings = {
  origin: string;
  optOut: string[];
  userId: string;
  cartCode: string;
};

type ApiResult = {
  ok?: boolean;
  status?: number;
  body?: unknown;
  error?: string;
};

const adapter = adapterFor(location);
if (adapter) {
  void start(adapter);
}

async function start(site: StoreAdapter): Promise<void> {
  let stopped = false;
  onContextDead = () => {
    stopped = true;
  };
  const settings = await loadSettings();
  if (stopped || !extensionContextAlive(chrome.runtime) || hostOptedOut(location.hostname, settings.optOut)) {
    return;
  }
  const gate = installGate(document, () => buttonsToBlock(site, document));
  let card: { update: (next: OverlayModel) => void; unmount: () => void } | null = null;

  let code = "";
  let bagOpen = false;
  let posting = false;
  let postedKey: string | null = null;
  let watching = false;
  let quantity: number | null = null;
  let pollTimer = 0;
  let fallbackTimer = 0;
  let showBlock = false;
  let bagWatch: BagWatch | null = null;
  let pageWatch: PageWatch | null = null;
  let lastParsed: string | null = null;
  let stopCheckout = (): void => undefined;

  const shutdown = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    window.clearInterval(pollTimer);
    window.clearTimeout(fallbackTimer);
    bagWatch?.disconnect();
    pageWatch?.disconnect();
    gate.stop();
    card?.unmount();
    stopCheckout();
  };
  onContextDead = shutdown;

  const releasePage = () => {
    if (stopped) {
      return;
    }
    window.clearInterval(pollTimer);
    window.clearTimeout(fallbackTimer);
    bagWatch?.disconnect();
    bagWatch = null;
    pageWatch?.disconnect();
    pageWatch = null;
    showBlock = false;
    gate.lift();
    gate.stop();
    card?.unmount();
    card = null;
  };

  stopCheckout = bindCheckoutClicks(
    document,
    () => site.checkoutButtons(document),
    () => ({ code, unlocked: bagOpen }),
    recordCheckout,
  );

  const actions = {
    unlock: () => {
      void post(`/api/carts/${code}/unlock`).then(() => refresh());
    },
    sleep: () => {
      void post(`/api/carts/${code}/sleep`).then(() => refresh());
    },
    ...(import.meta.env.VITE_SIMMER_DEMO === "1"
      ? {
          skipVault: () => {
            void post(`/api/carts/${code}/skip-vault`).then(() => refresh());
          },
          demoReply: (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) {
              return;
            }
            void post("/api/dev/reply", { code, text: trimmed }).then(() => refresh());
          },
        }
      : {}),
  };

  const show = (model: OverlayModel) => {
    if (!card) {
      card = mountSimmerCard(site, document, css, model, actions);
      return;
    }
    card.update(model);
  };

  const refresh = async () => {
    if (!code || stopped) {
      return;
    }
    const current = code;
    const cart = await getJson(`/api/carts/${current}`);
    if (current !== code || stopped) {
      return;
    }
    if (!isRecord(cart)) {
      show(emptyModel(settings, code, "Simmer can't reach the local server."));
      return;
    }
    const unlocked = cart.isUnlocked === true && cart.status === "unlocked";
    bagOpen = unlocked;
    if (unlocked) {
      showBlock = false;
      gate.lift();
    } else {
      showBlock = true;
      paintLock();
    }
    if (cart.necessity === "necessary") {
      show(modelFrom(cart, null, settings, null, quantity));
      return;
    }
    if (unlocked) {
      releasePage();
      return;
    }
    show(modelFrom(cart, null, settings, null, quantity));
  };

  const publish = async (interpreted: PageBag) => {
    if (posting) {
      return;
    }
    // A cart already exists. Post again only when the bag line itself changed.
    if (code && bagReadAction(postedKey, interpreted) !== "post") {
      return;
    }
    posting = true;
    if (interpreted.quantity != null) {
      quantity = interpreted.quantity;
    }
    try {
      if (site.isOrderConfirmation(document)) {
        return;
      }
      if (!interpreted.parsed && settings.cartCode && applePage(location.href) === "checkout") {
        code = settings.cartCode;
        await refresh();
        return;
      }
      const bag = site.readBag(document);
      if (!bag) {
        show(emptyModel(settings, code || "------", "Couldn't read bag"));
        if (!code) {
          await post("/api/carts", {
            userId: settings.userId,
            itemNames: [],
            totalCents: 0,
            parsed: false,
            pageHost: location.hostname,
          });
        }
        return;
      }
      const created = await post("/api/carts", {
        userId: settings.userId,
        itemNames: bag.items.map((item) => item.item).slice(0, 1),
        totalCents: bag.total,
        parsed: true,
        pageHost: location.hostname,
      });
      if (stopped) {
        return;
      }
      if (!isRecord(created) || typeof created.code !== "string") {
        if (!code) {
          show(emptyModel(settings, "------", "Simmer can't reach the local server."));
        }
        return;
      }
      const previous = code;
      code = created.code;
      postedKey = bagContentKey(interpreted);
      if (previous !== code) {
        await rememberCart(code);
      }
      if (stopped) {
        return;
      }
      const opened = created.isUnlocked === true && created.status === "unlocked";
      bagOpen = opened;
      if (opened) {
        showBlock = false;
        gate.lift();
      } else {
        showBlock = true;
        paintLock();
      }
      if (previous !== "" && previous === code) {
        await refresh();
      } else {
        show(modelFrom(created, { turns: [] }, settings, null, quantity));
        if (opened && created.necessity !== "necessary") {
          releasePage();
        }
      }
      if (!watching && card) {
        watching = true;
        pollTimer = window.setInterval(() => {
          if (stopped || !extensionContextAlive(chrome.runtime)) {
            shutdown();
            return;
          }
          void refresh();
        }, 1000);
      }
    } finally {
      posting = false;
    }
  };

  // One initial read, then only when the bag area itself changes. The 1s timer polls lock state.
  const readBagNow = () => {
    if (!document.body || stopped || posting || site.isOrderConfirmation(document)) {
      return;
    }
    const interpreted = readActiveBag(site, document);
    if (interpreted.quantity != null) {
      quantity = interpreted.quantity;
    }
    const parsedKey = bagParseKey(interpreted);
    if (parsedKey !== null && parsedKey === lastParsed) {
      return;
    }
    if (parsedKey !== null) {
      lastParsed = parsedKey;
    }
    if (code) {
      const action = bagReadAction(postedKey, interpreted);
      switch (action) {
        case "post":
          void publish(interpreted);
          return;
        case "keep":
          return;
        default: {
          const unreachable: never = action;
          return unreachable;
        }
      }
    }
    if (interpreted.parsed && interpreted.itemNames.length > 0) {
      void publish(interpreted);
    }
  };

  const paintLock = () => {
    const write = () => gate.paint();
    if (pageWatch) {
      pageWatch.mute(write);
      return;
    }
    write();
  };

  whenReady(() => {
    bagWatch = watchBagDom(document, readBagNow);
    pageWatch = watchPage(document, () => {
      if (stopped) {
        return;
      }
      if (showBlock) {
        paintLock();
      }
      if (bagWatch && !bagWatch.connected() && bagWatch.retarget()) {
        readBagNow();
      }
    });
    readBagNow();
  });
  fallbackTimer = window.setTimeout(() => {
    if (!code && !stopped && !site.isOrderConfirmation(document)) {
      const interpreted = readActiveBag(site, document);
      if (interpreted.parsed && interpreted.itemNames.length > 0) {
        void publish(interpreted);
        return;
      }
      show(emptyModel(settings, "------", "Couldn't read bag"));
      void post("/api/carts", {
        userId: settings.userId,
        itemNames: [],
        totalCents: 0,
        parsed: false,
        pageHost: location.hostname,
      });
    }
  }, 4000);
}

function modelFrom(
  cart: Record<string, unknown>,
  thread: unknown,
  settings: Settings,
  error: string | null,
  quantity: number | null,
): OverlayModel {
  const ping = isRecord(cart.lastPing) ? cart.lastPing : null;
  const turns = isRecord(thread) && Array.isArray(thread.turns) ? thread.turns.flatMap(turnFrom) : [];
  const names = Array.isArray(cart.items)
    ? cart.items.flatMap((item) => (isRecord(item) && typeof item.name === "string" ? [item.name] : []))
    : [];
  const status = cart.status === "vault" || cart.status === "unlocked" || cart.status === "locked" ? cart.status : "locked";
  return {
    code: typeof cart.code === "string" ? cart.code : "",
    status,
    isUnlocked: cart.isUnlocked === true,
    replied: cart.replied === true,
    advice: typeof cart.advice === "string" ? cart.advice : null,
    lockEndsAt: typeof cart.lockEndsAt === "string" ? cart.lockEndsAt : new Date(Date.now() + 600_000).toISOString(),
    vaultUntil: typeof cart.vaultUntil === "string" ? cart.vaultUntil : null,
    totalCents: typeof cart.totalCents === "number" ? cart.totalCents : 0,
    parsedFromPage: cart.parsedFromPage === true,
    itemNames: names,
    quantity,
    explanation: typeof cart.explanation === "string" ? cart.explanation : null,
    decision: isRecord(cart.decision) ? decisionFrom(cart.decision) : null,
    signals: signalsFrom(cart.signals),
    motiveSources: sourcesFrom(cart.motiveSources),
    reading: cart.reading === true,
    userId: settings.userId,
    linkMessage: typeof cart.linkMessage === "string" ? cart.linkMessage : `link ${settings.userId}`,
    fallbackPage: isFallbackBag(location.href),
    pingDelivered: ping?.delivered === true,
    pingReason: ping?.reason === "send_failed" || ping?.reason === "unlinked" ? ping.reason : null,
    smsLink: typeof ping?.smsLink === "string" ? ping.smsLink : typeof cart.smsLink === "string" ? cart.smsLink : null,
    qrDataUrl: typeof ping?.qrDataUrl === "string" ? ping.qrDataUrl : null,
    turns,
    error,
    necessity: cart.necessity === "necessary" || cart.necessity === "unnecessary" ? cart.necessity : null,
    necessitySource: typeof cart.necessitySource === "string" ? cart.necessitySource : null,
    necessityReason: typeof cart.necessityReason === "string" ? cart.necessityReason : null,
    userImpulseScore: typeof cart.userImpulseScore === "number" ? cart.userImpulseScore : null,
    justificationGrade: typeof cart.justificationGrade === "number" ? cart.justificationGrade : null,
    gradeSource: typeof cart.gradeSource === "string" ? cart.gradeSource : null,
    gradeReason: typeof cart.gradeReason === "string" ? cart.gradeReason : null,
    purchaseScore: typeof cart.purchaseScore === "number" ? cart.purchaseScore : null,
    scoreBucket: cart.scoreBucket === "free" || cart.scoreBucket === "soft" || cart.scoreBucket === "strict" ? cart.scoreBucket : null,
    scoreReason: typeof cart.scoreReason === "string" ? cart.scoreReason : null,
  };
}

function signalsFrom(value: unknown): OverlayModel["signals"] {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...(typeof value.needVsWant === "string" ? { needVsWant: value.needVsWant } : {}),
    ...(typeof value.urgency === "string" ? { urgency: value.urgency } : {}),
    ...(typeof value.currentPhoneBroken === "boolean" ? { currentPhoneBroken: value.currentPhoneBroken } : {}),
    ...(typeof value.reasonText === "string" ? { reasonText: value.reasonText } : {}),
  };
}

function sourcesFrom(value: unknown): OverlayModel["motiveSources"] {
  if (!isRecord(value)) {
    return null;
  }
  const read = (key: string) => (typeof value[key] === "string" ? value[key] : "default");
  return {
    needVsWant: read("needVsWant"),
    urgency: read("urgency"),
    currentPhoneBroken: read("currentPhoneBroken"),
    reasonText: read("reasonText"),
  };
}

function decisionFrom(value: Record<string, unknown>): OverlayModel["decision"] {
  if (!Array.isArray(value.tradeInCurve) || (value.action !== "sleep" && value.action !== "unlock")) {
    return null;
  }
  const curve = value.tradeInCurve.flatMap((point) => {
    if (!isRecord(point) || typeof point.month !== "number" || typeof point.cents !== "number") {
      return [];
    }
    return [{ month: point.month, cents: point.cents }];
  });
  const mathAction = value.mathAction === "sleep" || value.mathAction === "unlock" ? value.mathAction : value.action;
  const signalEffect =
    value.signalEffect === "need_unlock" || value.signalEffect === "want_sleep" || value.signalEffect === "math"
      ? value.signalEffect
      : "math";
  return {
    action: value.action,
    mathAction,
    mathWaitMonths: typeof value.mathWaitMonths === "number" ? value.mathWaitMonths : 0,
    mathSavingsCents: typeof value.mathSavingsCents === "number" ? value.mathSavingsCents : 0,
    signalEffect,
    financingAction: value.financingAction === "sleep" || value.financingAction === "unlock" ? value.financingAction : mathAction,
    financingSavingsCents: typeof value.financingSavingsCents === "number" ? value.financingSavingsCents : 0,
    offerId: typeof value.offerId === "string" ? value.offerId : null,
    offerName: typeof value.offerName === "string" ? value.offerName : null,
    offerSavingCents: typeof value.offerSavingCents === "number" ? value.offerSavingCents : 0,
    offerMonthsFromNow: typeof value.offerMonthsFromNow === "number" ? value.offerMonthsFromNow : 0,
    waitMonths: typeof value.waitMonths === "number" ? value.waitMonths : 0,
    savingsCents: typeof value.savingsCents === "number" ? value.savingsCents : 0,
    costNowCents: typeof value.costNowCents === "number" ? value.costNowCents : 0,
    costLaterCents: typeof value.costLaterCents === "number" ? value.costLaterCents : 0,
    tradeInNowCents: typeof value.tradeInNowCents === "number" ? value.tradeInNowCents : 0,
    tradeInLaterCents: typeof value.tradeInLaterCents === "number" ? value.tradeInLaterCents : 0,
    financingNowCents: typeof value.financingNowCents === "number" ? value.financingNowCents : 0,
    financingLaterCents: typeof value.financingLaterCents === "number" ? value.financingLaterCents : 0,
    newDeviceCents: typeof value.newDeviceCents === "number" ? value.newDeviceCents : 0,
    tradeInCurve: curve,
  };
}

function turnFrom(value: unknown): { role: "shopper" | "agent"; text: string }[] {
  if (!isRecord(value) || (value.role !== "shopper" && value.role !== "agent") || typeof value.text !== "string") {
    return [];
  }
  return [{ role: value.role, text: value.text }];
}

function emptyModel(settings: Settings, code: string, error: string): OverlayModel {
  return {
    code,
    status: "locked",
    isUnlocked: false,
    replied: false,
    advice: null,
    lockEndsAt: new Date(Date.now() + 600_000).toISOString(),
    vaultUntil: null,
    totalCents: 0,
    parsedFromPage: false,
    itemNames: [],
    quantity: null,
    explanation: null,
    decision: null,
    signals: {},
    motiveSources: null,
    reading: false,
    userId: settings.userId,
    linkMessage: `link ${settings.userId}`,
    fallbackPage: isFallbackBag(location.href),
    pingDelivered: false,
    pingReason: "unlinked",
    smsLink: null,
    qrDataUrl: null,
    turns: [],
    error,
    necessity: null,
    necessitySource: null,
    necessityReason: null,
    userImpulseScore: null,
    justificationGrade: null,
    gradeSource: null,
    gradeReason: null,
    purchaseScore: null,
    scoreBucket: null,
    scoreReason: null,
  };
}

function loadSettings(): Promise<Settings> {
  return message({ type: "simmer", action: "settings" }).then((value) => {
    const record = isRecord(value) ? value : {};
    return {
      origin: typeof record.origin === "string" ? record.origin : "http://127.0.0.1:4321",
      optOut: Array.isArray(record.optOut) ? record.optOut.filter((item): item is string => typeof item === "string") : [],
      userId: typeof record.userId === "string" ? record.userId : "user-local",
      cartCode: typeof record.cartCode === "string" ? record.cartCode : "",
    };
  });
}

function rememberCart(code: string): Promise<void> {
  return message({ type: "simmer", action: "remember-cart", code }).then(() => undefined);
}

function post(path: string, body?: unknown): Promise<unknown> {
  return message({ type: "simmer", action: "api", method: "POST", path, body }).then(unwrap);
}

function recordCheckout(cartCode: string): Promise<void> {
  return message({ type: "simmer", action: "api", method: "POST", path: "/purchases", body: { cartCode } }).then((result) => {
    if (!isRecord(result) || result.ok !== true) {
      throw new Error("Purchase was not recorded.");
    }
  });
}

function getJson(path: string): Promise<unknown> {
  return message({ type: "simmer", action: "api", method: "GET", path }).then(unwrap);
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) {
    return null;
  }
  return value.body ?? null;
}

function message(payload: unknown): Promise<unknown> {
  return deliverExtensionMessage(chrome.runtime, payload, () => onContextDead());
}

function whenReady(run: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
    return;
  }
  run();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
