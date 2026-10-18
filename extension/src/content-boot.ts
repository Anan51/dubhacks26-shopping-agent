import { postedItemNames } from "../../src/item-name.js";
import { applePage, hostOptedOut, isFallbackBag } from "../../src/sites.js";
import { bagContentKey, bagParseKey, bagReadAction, watchBagDom, type BagWatch, type PageBag } from "./bag-dom.js";
import { bindCheckoutClicks } from "./checkout-record.js";
import { deliverExtensionMessage, extensionContextAlive, type ExtensionRuntime } from "./extension-context.js";
import { installGate } from "./gate.js";
import { watchLocation } from "./history-hook.js";
import { buttonsToBlock } from "./overlay/block.js";
import { mountSimmerCard } from "./overlay/mount.js";
import { watchPage, type PageWatch } from "./page-observer.js";
import type { OverlayModel } from "./overlay.js";
import { readActiveBag } from "./store-bag.js";
import { adapterFor } from "./stores/index.js";
import type { StoreAdapter } from "./stores/adapter.js";

export type BootHost = {
  document: Document;
  location: Location;
  view: Window;
  runtime: () => ExtensionRuntime;
  css: string;
};

let active: BootHost;
let onContextDead = (): void => undefined;

/** Skip startup only when this is an Apple host and applePage() is null. */
export function skipAppleBrowse(href: string): boolean {
  let host = "";
  try {
    host = new URL(href).hostname.toLowerCase();
  } catch {
    return false;
  }
  const apple =
    host === "apple.com" || host.endsWith(".apple.com") || host === "apple.com.cn" || host.endsWith(".apple.com.cn");
  if (!apple) {
    return false;
  }
  return applePage(href) === null;
}

type Running = {
  reread: () => void;
  stop: () => void;
};

function sessions(): WeakMap<Document, Running> {
  const holder = globalThis as { __simmerBoot?: WeakMap<Document, Running> };
  holder.__simmerBoot ??= new WeakMap();
  return holder.__simmerBoot;
}

/** Real content-script entry. Idle on Apple browse pages; otherwise the matching store adapter. */
export function boot(host: BootHost): void {
  active = host;
  watchLocation(host.view, () => {
    boot(host);
  });
  const site = skipAppleBrowse(host.location.href) ? null : adapterFor(host.location);
  if (!site) {
    sessions().get(host.document)?.stop();
    sessions().delete(host.document);
    return;
  }
  const running = sessions().get(host.document);
  if (running) {
    running.reread();
    return;
  }
  sessions().set(host.document, start(site));
}

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

function start(site: StoreAdapter): Running {
  let stopped = false;
  let endSession = (): void => {
    stopped = true;
  };
  onContextDead = () => {
    endSession();
  };
  const page = active;
  if (!extensionContextAlive(page.runtime())) {
    stopped = true;
    return { reread: () => undefined, stop: () => undefined };
  }
  let settings: Settings = {
    origin: "http://127.0.0.1:4321",
    optOut: [],
    userId: "user-local",
    cartCode: "",
  };
  const settingsReady = loadSettings(page, (value) => {
    if (stopped) {
      return;
    }
    const loaded = settingsFrom(value);
    settings = loaded;
    if (hostOptedOut(page.location.hostname, loaded.optOut)) {
      endSession();
    }
  }).then((loaded) => {
    settings = loaded;
    if (!stopped && hostOptedOut(page.location.hostname, loaded.optOut)) {
      endSession();
    }
    return loaded;
  });
  const gate = installGate(page.document, () => buttonsToBlock(site, page.document));
  let card: { update: (next: OverlayModel) => void; unmount: () => void } | null = null;

  let code = "";
  let bagOpen = false;
  let posting = false;
  let postedKey: string | null = null;
  let watching = false;
  let quantity: number | null = null;
  let pollTimer = 0;
  let fallbackTimer = 0;
  let retryTimer = 0;
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
    endSession = () => undefined;
    page.view.clearInterval(pollTimer);
    page.view.clearTimeout(fallbackTimer);
    page.view.clearTimeout(retryTimer);
    bagWatch?.disconnect();
    pageWatch?.disconnect();
    gate.stop();
    card?.unmount();
    card = null;
    stopCheckout();
    sessions().delete(page.document);
  };
  endSession = shutdown;
  onContextDead = shutdown;

  const releasePage = () => {
    if (stopped) {
      return;
    }
    page.view.clearInterval(pollTimer);
    page.view.clearTimeout(fallbackTimer);
    page.view.clearTimeout(retryTimer);
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
    page.document,
    () => site.checkoutButtons(page.document),
    () => ({ code, unlocked: bagOpen }),
    (cartCode) => recordCheckout(page, cartCode),
  );

  const actions = {
    unlock: () => {
      void post(page, `/api/carts/${code}/unlock`).then(() => refresh());
    },
    sleep: () => {
      void post(page, `/api/carts/${code}/sleep`).then(() => refresh());
    },
    ...(import.meta.env?.VITE_SIMMER_DEMO === "1"
      ? {
          skipVault: () => {
            void post(page, `/api/carts/${code}/skip-vault`).then(() => refresh());
          },
          demoReply: (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) {
              return;
            }
            void post(page, "/api/dev/reply", { code, text: trimmed }).then(() => refresh());
          },
        }
      : {}),
  };

  const show = (model: OverlayModel) => {
    if (!card) {
      card = mountSimmerCard(site, page.document, page.css, model, actions);
      return;
    }
    card.update(model);
  };

  const refresh = async () => {
    if (!code || stopped) {
      return;
    }
    const current = code;
    const cart = await getJson(page, `/api/carts/${current}`);
    if (current !== code || stopped) {
      return;
    }
    if (!isRecord(cart)) {
      show(emptyModel(settings, code, "Simmer can't reach the local server."));
      return;
    }
    applyDecision(cart);
  };

  const applyDecision = (cart: Record<string, unknown>) => {
    if (stopped) {
      return;
    }
    page.view.clearTimeout(retryTimer);
    retryTimer = 0;
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

  const acceptCart = async (created: Record<string, unknown>, interpreted: PageBag) => {
    if (stopped || typeof created.code !== "string") {
      return;
    }
    const previous = code;
    code = created.code;
    postedKey = bagContentKey(interpreted);
    if (previous !== "" && previous === code) {
      await refresh();
      return;
    }
    applyDecision(created);
    if (stopped) {
      return;
    }
    if (previous !== code) {
      void rememberCart(page, code);
    }
    if (!watching && card && !stopped) {
      watching = true;
      pollTimer = page.view.setInterval(() => {
        if (stopped || !extensionContextAlive(page.runtime())) {
          shutdown();
          return;
        }
        void refresh();
      }, 1000);
    }
  };

  let scheduleRetry = (): void => undefined;

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
      if (site.isOrderConfirmation(page.document)) {
        return;
      }
      if (interpreted.parsed && interpreted.itemNames.length > 0) {
        show(previewModel(interpreted, settings));
        showBlock = true;
        paintLock();
      }
      const loaded = await settingsReady;
      if (stopped) {
        return;
      }
      settings = loaded;
      if (!interpreted.parsed && settings.cartCode && applePage(page.location.href) === "checkout") {
        code = settings.cartCode;
        await refresh();
        return;
      }
      const bag = site.readBag(page.document);
      if (!bag) {
        show(emptyModel(settings, code || "------", "Couldn't read bag"));
        if (!code) {
          await post(page, "/api/carts", {
            userId: settings.userId,
            itemNames: [],
            totalCents: 0,
            parsed: false,
            pageHost: page.location.hostname,
          });
        }
        return;
      }
      const created = await post(
        page,
        "/api/carts",
        {
          userId: settings.userId,
          itemNames: postedItemNames(bag.items.map((item) => item.item)),
          totalCents: bag.total,
          parsed: true,
          pageHost: page.location.hostname,
        },
        (value) => {
          const body = unwrap(value);
          if (isRecord(body) && typeof body.code === "string") {
            void acceptCart(body, interpreted);
          }
        },
      );
      if (stopped) {
        return;
      }
      if (!isRecord(created) || typeof created.code !== "string") {
        lastParsed = null;
        if (!code) {
          show({ ...previewModel(interpreted, settings), error: "Simmer can't reach the local server." });
          scheduleRetry();
        }
        return;
      }
      await acceptCart(created, interpreted);
    } finally {
      posting = false;
    }
  };

  // One initial read, then only when the bag area itself changes. The 1s timer polls lock state.
  const readBagNow = () => {
    if (!page.document.body || stopped || posting || site.isOrderConfirmation(page.document)) {
      return;
    }
    const interpreted = readActiveBag(site, page.document);
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

  scheduleRetry = () => {
    if (retryTimer || stopped || code) {
      return;
    }
    retryTimer = page.view.setTimeout(() => {
      retryTimer = 0;
      readBagNow();
    }, 1000);
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
    bagWatch = watchBagDom(page.document, readBagNow);
    pageWatch = watchPage(page.document, () => {
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
  const running: Running = {
    reread: () => {
      if (!stopped) {
        readBagNow();
      }
    },
    stop: shutdown,
  };

  fallbackTimer = page.view.setTimeout(() => {
    if (!code && !stopped && !site.isOrderConfirmation(page.document)) {
      const interpreted = readActiveBag(site, page.document);
      if (interpreted.parsed && interpreted.itemNames.length > 0) {
        void publish(interpreted);
        return;
      }
      show(emptyModel(settings, "------", "Couldn't read bag"));
      void post(page, "/api/carts", {
        userId: settings.userId,
        itemNames: [],
        totalCents: 0,
        parsed: false,
        pageHost: page.location.hostname,
      });
    }
  }, 4000);

  return running;
}

function previewModel(bag: PageBag, settings: Settings): OverlayModel {
  return {
    ...emptyModel(settings, "------", ""),
    error: null,
    totalCents: bag.totalCents ?? 0,
    parsedFromPage: true,
    itemNames: bag.itemNames,
    quantity: bag.quantity,
    pingReason: null,
  };
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
    fallbackPage: isFallbackBag(pageHref()),
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
    fallbackPage: isFallbackBag(pageHref()),
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

function loadSettings(host: BootHost, onLate?: (value: unknown) => void): Promise<Settings> {
  return message(host, { type: "simmer", action: "settings" }, onLate).then((value) => settingsFrom(value));
}

function settingsFrom(value: unknown): Settings {
  const record = isRecord(value) ? value : {};
  return {
    origin: typeof record.origin === "string" ? record.origin : "http://127.0.0.1:4321",
    optOut: Array.isArray(record.optOut) ? record.optOut.filter((item): item is string => typeof item === "string") : [],
    userId: typeof record.userId === "string" ? record.userId : "user-local",
    cartCode: typeof record.cartCode === "string" ? record.cartCode : "",
  };
}

function rememberCart(host: BootHost, code: string): Promise<void> {
  return message(host, { type: "simmer", action: "remember-cart", code }).then(() => undefined);
}

function post(host: BootHost, path: string, body?: unknown, onLate?: (value: unknown) => void): Promise<unknown> {
  return message(host, { type: "simmer", action: "api", method: "POST", path, body }, onLate).then(unwrap);
}

function recordCheckout(host: BootHost, cartCode: string): Promise<void> {
  return message(host, { type: "simmer", action: "api", method: "POST", path: "/purchases", body: { cartCode } }).then((result) => {
    if (!isRecord(result) || result.ok !== true) {
      throw new Error("Purchase was not recorded.");
    }
  });
}

function getJson(host: BootHost, path: string, onLate?: (value: unknown) => void): Promise<unknown> {
  return message(host, { type: "simmer", action: "api", method: "GET", path }, onLate).then(unwrap);
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) {
    return null;
  }
  return value.body ?? null;
}

function message(host: BootHost, payload: unknown, onLate?: (value: unknown) => void): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) {
        onLate?.(value);
        return;
      }
      settled = true;
      resolve(value);
    };
    const timer = host.view.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(null);
    }, 2500);
    void deliverExtensionMessage(host.runtime(), payload, () => {
      host.view.clearTimeout(timer);
      sessions().get(host.document)?.stop();
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }).then(
      (value) => {
        host.view.clearTimeout(timer);
        finish(value);
      },
      () => {
        host.view.clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    );
  });
}

function pageHref(): string {
  return active.location.href;
}

function whenReady(run: () => void): void {
  if (active.document.readyState === "loading") {
    active.document.addEventListener("DOMContentLoaded", run, { once: true });
    return;
  }
  run();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
