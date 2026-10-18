import css from "./overlay.css?inline";

import { bagOrFallback, interpretBag, isBlockedControl, type BagControl, type InterpretedBag } from "../../src/apple-bag.js";
import { applePage, hostOptedOut, type ApplePage } from "../../src/sites.js";
import { mountOverlay, type OverlayModel } from "./overlay.js";

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

const page = applePage(location.href);
if (page) {
  void start(page);
}

async function start(kind: ApplePage): Promise<void> {
  const settings = await loadSettings();
  if (hostOptedOut(location.hostname, settings.optOut)) {
    return;
  }
  const gate = installGate(kind);
  const host = document.createElement("div");
  host.id = "simmer-root";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.append(style);
  (document.documentElement ?? document).append(host);

  let code = "";
  let posting = false;
  let update = (_next: OverlayModel): void => undefined;
  let mounted = false;
  let stopped = false;

  const actions = {
    unlock: () => {
      void post(`/api/carts/${code}/unlock`).then(() => refresh());
    },
    sleep: () => {
      void post(`/api/carts/${code}/sleep`).then(() => refresh());
    },
    skipVault: () => {
      void post(`/api/carts/${code}/skip-vault`).then(() => refresh());
    },
    send: (text: string) => {
      const conversationId = `desk:cart-${code}`;
      void post("/api/dev/messages", { conversationId, text }).then(() => refresh());
    },
  };

  const show = (model: OverlayModel) => {
    if (!mounted) {
      update = mountOverlay(shadow, model, actions);
      mounted = true;
      return;
    }
    update(model);
  };

  const refresh = async () => {
    if (!code || stopped) {
      return;
    }
    const cart = await getJson(`/api/carts/${code}`);
    const thread = await getJson(`/api/dev/messages?conversationId=${encodeURIComponent(`desk:cart-${code}`)}`);
    if (!isRecord(cart)) {
      show(emptyModel(settings, code, "Simmer can't reach the local server."));
      return;
    }
    if (cart.isUnlocked === true && cart.status === "unlocked") {
      stopped = true;
      gate.lift();
      host.remove();
      return;
    }
    show(modelFrom(cart, thread, settings, null));
    gate.paint();
  };

  const publish = async (interpreted: InterpretedBag) => {
    if (code || posting) {
      return;
    }
    posting = true;
    try {
      if (!interpreted.parsed && settings.cartCode && kind === "checkout") {
        code = settings.cartCode;
        await refresh();
        return;
      }
      const bag = bagOrFallback(interpreted);
      const created = await post("/api/carts", {
        userId: settings.userId,
        itemNames: bag.itemNames.slice(0, 1),
        totalCents: bag.totalCents,
        parsed: bag.parsed,
        pageHost: location.hostname,
      });
      if (!isRecord(created) || typeof created.code !== "string") {
        show(emptyModel(settings, "------", "Simmer can't reach the local server."));
        return;
      }
      code = created.code;
      await rememberCart(code);
      show(modelFrom(created, { turns: [] }, settings, null));
      window.setInterval(() => {
        void refresh();
      }, 1000);
    } finally {
      posting = false;
    }
  };

  const attempt = () => {
    if (!document.body || code) {
      return;
    }
    const interpreted = interpretBag(linesFrom(document.body));
    if (interpreted.parsed) {
      void publish(interpreted);
    }
  };

  const observer = new MutationObserver(() => {
    gate.paint();
    attempt();
  });
  whenReady(() => {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    attempt();
  });
  window.setTimeout(() => {
    if (!code) {
      void publish(interpretBag(document.body ? linesFrom(document.body) : []));
    }
  }, 4000);
}

function installGate(kind: ApplePage): { paint: () => void; lift: () => void } {
  // Lift only clears the block. It must never click, submit, or complete Apple's button.
  let blocked = true;
  const stop = (event: Event) => {
    if (!blocked) {
      return;
    }
    const control = controlFrom(event.target);
    if (!control || !isBlockedControl(control, kind)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const stopSubmit = (event: Event) => {
    if (!blocked || !(event instanceof SubmitEvent)) {
      return;
    }
    const control = controlFrom(event.submitter);
    if (!control || !isBlockedControl(control, kind)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  window.addEventListener("click", stop, true);
  window.addEventListener("pointerdown", stop, true);
  window.addEventListener("submit", stopSubmit, true);
  const paint = () => {
    if (!document.body) {
      return;
    }
    const nodes = document.querySelectorAll("button, a, input, apple-pay-button, [role='button']");
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const control = controlFrom(node);
      const mark = blocked && control !== null && isBlockedControl(control, kind);
      if (mark) {
        node.setAttribute("data-simmer-blocked", "1");
        node.setAttribute("aria-disabled", "true");
      } else if (node.hasAttribute("data-simmer-blocked")) {
        node.removeAttribute("data-simmer-blocked");
        node.removeAttribute("aria-disabled");
      }
    }
  };
  return {
    paint,
    lift: () => {
      blocked = false;
      paint();
    },
  };
}

function linesFrom(root: ParentNode): string[] {
  const element = root instanceof HTMLElement ? root : document.body;
  if (!element) {
    return [];
  }
  return element.innerText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && line.length < 180);
}

function controlFrom(target: EventTarget | null): BagControl | null {
  const element = target instanceof Element ? target : null;
  const control = element?.closest("button, a, input, apple-pay-button, [role='button']");
  if (!(control instanceof HTMLElement)) {
    return null;
  }
  return {
    tag: control.tagName.toLowerCase(),
    text: control.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
    ariaLabel: control.getAttribute("aria-label") ?? "",
  };
}

function modelFrom(cart: Record<string, unknown>, thread: unknown, settings: Settings, error: string | null): OverlayModel {
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
    lockEndsAt: typeof cart.lockEndsAt === "string" ? cart.lockEndsAt : new Date(Date.now() + 600_000).toISOString(),
    vaultUntil: typeof cart.vaultUntil === "string" ? cart.vaultUntil : null,
    totalCents: typeof cart.totalCents === "number" ? cart.totalCents : 0,
    parsedFromPage: cart.parsedFromPage === true,
    itemNames: names,
    explanation: typeof cart.explanation === "string" ? cart.explanation : null,
    decision: isRecord(cart.decision) ? decisionFrom(cart.decision) : null,
    reading: cart.reading === true,
    userId: settings.userId,
    linkMessage: typeof cart.linkMessage === "string" ? cart.linkMessage : `link ${settings.userId}`,
    pingDelivered: ping?.delivered === true,
    pingReason: ping?.reason === "send_failed" || ping?.reason === "unlinked" ? ping.reason : null,
    smsLink: typeof ping?.smsLink === "string" ? ping.smsLink : typeof cart.smsLink === "string" ? cart.smsLink : null,
    qrDataUrl: typeof ping?.qrDataUrl === "string" ? ping.qrDataUrl : null,
    turns,
    error,
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
  return {
    action: value.action,
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
    lockEndsAt: new Date(Date.now() + 600_000).toISOString(),
    vaultUntil: null,
    totalCents: 0,
    parsedFromPage: false,
    itemNames: [],
    explanation: null,
    decision: null,
    reading: false,
    userId: settings.userId,
    linkMessage: `link ${settings.userId}`,
    pingDelivered: false,
    pingReason: "unlinked",
    smsLink: null,
    qrDataUrl: null,
    turns: [],
    error,
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
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (value) => {
      resolve(chrome.runtime.lastError ? null : value);
    });
  });
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
