import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { DEMO_REPLY_PRESETS } from "../../src/demo-reply-presets.js";
import { formatUsd } from "../../src/format.js";
import { cartItemLines, readHiddenItemCount } from "../../src/item-name.js";
import { overlayClockText, type GlanceItem, type GlanceSignals, type GlanceSources } from "../../src/glance.js";
import { offersSleep } from "../../src/score-band.js";
import { pausedLinkLine } from "../../src/links.js";
import { pauseSentence, priceLine, simmerKicker } from "../../src/overlay-copy.js";
import type { Decision } from "../../src/types.js";

import { quantityTotalLabel } from "./bag-dom.js";

export type OverlayModel = {
  code: string;
  status: "locked" | "vault" | "unlocked";
  isUnlocked: boolean;
  lockEndsAt: string;
  vaultUntil: string | null;
  totalCents: number;
  parsedFromPage: boolean;
  itemNames: string[];
  /** Distinct titles omitted from itemNames. The list prints "+k more". */
  hiddenItemCount?: number;
  quantity: number | null;
  explanation: string | null;
  decision: Decision | null;
  signals: GlanceSignals;
  motiveSources: GlanceSources | null;
  reading: boolean;
  userId: string;
  linkMessage: string | null;
  /** Agent iMessage handle from GET /api/config. Empty when PHOTON_AGENT_HANDLE is unset. */
  agentHandle?: string | null;
  fallbackPage: boolean;
  replied: boolean;
  advice: string | null;
  pingDelivered: boolean;
  pingReason: "unlinked" | "send_failed" | null;
  smsLink: string | null;
  qrDataUrl: string | null;
  turns: { role: "shopper" | "agent"; text: string }[];
  error: string | null;
  necessity: "necessary" | "unnecessary" | null;
  necessitySource: string | null;
  necessityReason: string | null;
  userImpulseScore: number | null;
  justificationGrade: number | null;
  gradeSource: string | null;
  gradeReason: string | null;
  purchaseScore: number | null;
  scoreBucket: "free" | "soft" | "strict" | null;
  scoreReason: string | null;
  /** Break-even sentence for a carrier switch. Absent on Apple and Amazon. */
  carrierLine?: string | null;
};

export type OverlayActions = {
  unlock: () => void;
  sleep: () => void;
  skipVault?: () => void;
  demoReply?: (text: string) => void;
};

export function mountOverlay(
  parent: ShadowRoot,
  initial: OverlayModel,
  actions: OverlayActions,
): (next: OverlayModel) => void {
  const mount = parent.ownerDocument.createElement("div");
  parent.append(mount);
  let model = initial;
  const listeners = new Set<() => void>();
  function Bridge() {
    const current = useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => model,
      () => model,
    );
    return <Overlay model={current} actions={actions} />;
  }
  createRoot(mount).render(<Bridge />);
  return (next) => {
    model = next;
    for (const listener of listeners) {
      listener();
    }
  };
}

function Overlay({ model, actions }: { model: OverlayModel; actions: OverlayActions }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, new Date(model.lockEndsAt).getTime() - now);
  const glance = toGlance(model);
  const unreadable = model.error === "Couldn't read bag";
  const title = unreadable
    ? "Couldn't read bag"
    : model.necessity === "necessary" && model.purchaseScore == null
      ? "Necessary buy"
      : model.status === "unlocked"
        ? "Unlocked"
        : model.status === "vault"
          ? "Paused"
          : "Marinating";
  const clock = overlayClockText(glance, now, remaining);
  const showLockControls = model.necessity !== "necessary" && !unreadable;
  const unlinked = !model.pingDelivered && model.pingReason !== "send_failed" && model.linkMessage;
  const linkLine = unlinked ? pausedLinkLine(model.linkMessage, model.agentHandle ?? null) : null;
  const lines = cartItemLines(model.itemNames);
  const more = Math.max(lines.more, readHiddenItemCount(model.hiddenItemCount));
  const showItems = !unreadable && model.quantity != null && lines.shown.length > 0;
  return (
    <div className="panel">
      <section className="card" role="dialog" aria-labelledby="simmer-title">
        <p className="kicker">{simmerKicker(model.fallbackPage)}</p>
        <h1 id="simmer-title">{title}</h1>
        {showItems ? (
          <ul className="bag-items">
            {lines.shown.map((name, index) => (
              <li key={`${index}:${name}`}>{name}</li>
            ))}
            {more > 0 ? <li className="fine">+{more} more</li> : null}
          </ul>
        ) : null}
        {unreadable ? null : (
          <p>
            {model.quantity != null
              ? quantityTotalLabel(model.quantity, model.totalCents)
              : `${model.itemNames[0] ?? "Apple bag"} · ${formatUsd(model.totalCents)}`}
          </p>
        )}
        {model.fallbackPage ? <p className="fine">Example data.</p> : null}
        {model.carrierLine ? <p className="why">{model.carrierLine}</p> : null}
        {unreadable ? null : (
          <p className="clock" aria-live="polite">
            {clock}
          </p>
        )}
        {showLockControls && !model.replied ? <p>Reply to Simmer's iMessage to unlock.</p> : null}
        {showLockControls && model.replied && model.advice ? <p>{model.advice}</p> : null}
        {showLockControls && linkLine ? <p>{linkLine}</p> : null}
        <div className="row">
          {showLockControls && model.replied ? (
            <button type="button" onClick={actions.unlock}>
              Unlock
            </button>
          ) : null}
          <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            Why
          </button>
        </div>
        {import.meta.env?.VITE_SIMMER_DEMO === "1" && actions.demoReply ? <DemoReplyForm onSend={actions.demoReply} /> : null}
        {open ? (
          <div>
            {model.carrierLine ? null : (
              <p className="why">{unreadable ? "The Apple bag could not be read." : pauseSentence(glance)}</p>
            )}
            {unreadable ? null : <p>{priceLine(model.totalCents, { cents: glance.decision?.costLaterCents ?? 0, example: true })}</p>}
            <div className="row">
              {showSleepControl(model) ? (
                <button type="button" className="quiet" onClick={actions.sleep}>
                  Sleep on it
                </button>
              ) : null}
              {import.meta.env?.VITE_SIMMER_DEMO === "1" && model.status === "vault" && actions.skipVault ? (
                <button type="button" className="quiet" onClick={actions.skipVault}>
                  Demo: end the pause
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {model.error ? <p role="alert">{model.error}</p> : null}
      </section>
    </div>
  );
}

/** Sleep is shown only when the server accepts POST /sleep (soft scores 2–3). */
export function showSleepControl(model: Pick<OverlayModel, "necessity" | "error" | "scoreBucket">): boolean {
  const unreadable = model.error === "Couldn't read bag";
  const showLockControls = model.necessity !== "necessary" && !unreadable;
  return showLockControls && offersSleep(model.scoreBucket);
}

function toGlance(model: OverlayModel): GlanceItem {
  return {
    code: model.code,
    name: model.itemNames[0] ?? "Apple bag",
    priceCents: model.totalCents,
    status: model.status,
    vaultUntil: model.vaultUntil,
    decision: model.decision
      ? {
          action: model.decision.action,
          waitMonths: model.decision.waitMonths,
          savingsCents: model.decision.savingsCents,
          offerName: model.decision.offerName,
          costNowCents: model.decision.costNowCents,
          costLaterCents: model.decision.costLaterCents,
          tradeInNowCents: model.decision.tradeInNowCents,
          tradeInLaterCents: model.decision.tradeInLaterCents,
          financingNowCents: model.decision.financingNowCents,
          financingLaterCents: model.decision.financingLaterCents,
          mathAction: model.decision.mathAction,
          mathWaitMonths: model.decision.mathWaitMonths,
          mathSavingsCents: model.decision.mathSavingsCents,
        }
      : null,
    signals: model.signals,
    motiveSources: model.motiveSources,
    necessity: model.necessity,
    necessitySource: model.necessitySource,
    necessityReason: model.necessityReason,
    userImpulseScore: model.userImpulseScore,
    justificationGrade: model.justificationGrade,
    gradeSource: model.gradeSource,
    gradeReason: model.gradeReason,
    purchaseScore: model.purchaseScore,
    scoreBucket: model.scoreBucket,
    scoreReason: model.scoreReason,
    replied: model.replied,
    advice: model.advice,
  };
}

function DemoReplyForm({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  if (import.meta.env?.VITE_SIMMER_DEMO !== "1") {
    return null;
  }
  return (
    <form
      className="demo-reply"
      data-simmer-demo-reply="simmer-demo-reply"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = text.trim();
        if (!trimmed) {
          return;
        }
        onSend(trimmed);
      }}
    >
      <label>
        Simulate reply
        <input
          value={text}
          maxLength={2000}
          placeholder="Type a reply"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="row">
        <button type="submit" className="quiet">
          Send
        </button>
        {DEMO_REPLY_PRESETS.map((preset) => (
          <button key={preset} type="button" className="quiet" onClick={() => onSend(preset)}>
            {preset}
          </button>
        ))}
      </div>
    </form>
  );
}
