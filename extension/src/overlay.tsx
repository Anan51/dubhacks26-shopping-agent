import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { formatUsd } from "../../src/format.js";
import { breakdownLines, oneLineVerdict, type GlanceItem, type GlanceSignals, type GlanceSources } from "../../src/glance.js";
import { UPGRADE_PROMPT } from "../../src/links.js";
import type { Decision } from "../../src/types.js";

export type OverlayModel = {
  code: string;
  status: "locked" | "vault" | "unlocked";
  isUnlocked: boolean;
  lockEndsAt: string;
  vaultUntil: string | null;
  totalCents: number;
  parsedFromPage: boolean;
  itemNames: string[];
  explanation: string | null;
  decision: Decision | null;
  signals: GlanceSignals;
  motiveSources: GlanceSources | null;
  reading: boolean;
  userId: string;
  linkMessage: string | null;
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
};

export type OverlayActions = {
  unlock: () => void;
  sleep: () => void;
  skipVault: () => void;
  send: (text: string) => void;
};

export function mountOverlay(
  parent: ShadowRoot,
  initial: OverlayModel,
  actions: OverlayActions,
): (next: OverlayModel) => void {
  const mount = document.createElement("div");
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
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, new Date(model.lockEndsAt).getTime() - now);
  const glance = toGlance(model);
  const title =
    model.necessity === "necessary" && model.purchaseScore == null
      ? "Necessary buy"
      : model.status === "unlocked"
        ? "Unlocked"
        : model.status === "vault"
          ? "In the Vault"
          : "Marinating";
  const clock =
    model.necessity === "necessary" && model.purchaseScore == null
      ? "Checkout can proceed"
      : model.purchaseScore != null || model.status === "vault"
        ? oneLineVerdict(glance, now)
        : remaining > 0
          ? clockFrom(remaining)
          : "0:00";
  return (
    <div className="panel">
      <section className="card" role="dialog" aria-labelledby="simmer-title">
        <p className="kicker">Simmer · example data</p>
        <h1 id="simmer-title">{title}</h1>
        <p>
          {model.itemNames[0] ?? "Apple bag"} · {formatUsd(model.totalCents)}
        </p>
        <p className="clock" aria-live="polite">
          {clock}
        </p>
        <div className="row">
          <button type="button" onClick={actions.unlock}>
            Unlock
          </button>
          <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            Why
          </button>
        </div>
        {open ? (
          <div>
            <dl>
              {breakdownLines(glance).map((line) => (
                <div key={line.label}>
                  <dt>{line.label}</dt>
                  <dd>{line.value}</dd>
                </div>
              ))}
            </dl>
            <div className="row">
              <button type="button" className="quiet" onClick={actions.sleep}>
                Sleep on it
              </button>
              {model.status === "vault" ? (
                <button type="button" className="quiet" onClick={actions.skipVault}>
                  Demo: skip 24 hours
                </button>
              ) : null}
            </div>
            <p className="fine">{UPGRADE_PROMPT}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (!text) {
                  return;
                }
                setDraft("");
                actions.send(text);
              }}
            >
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Message Simmer" />
              <button type="submit">Send</button>
            </form>
            {!model.pingDelivered && model.smsLink ? <p><a href={model.smsLink}>sms: link</a></p> : null}
          </div>
        ) : null}
        {model.error ? <p role="alert">{model.error}</p> : null}
      </section>
    </div>
  );
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
  };
}

function clockFrom(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
