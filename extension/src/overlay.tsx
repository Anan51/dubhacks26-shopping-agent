import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { formatUsd } from "../../src/format.js";
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
  reading: boolean;
  userId: string;
  linkMessage: string | null;
  pingDelivered: boolean;
  pingReason: "unlinked" | "send_failed" | null;
  smsLink: string | null;
  qrDataUrl: string | null;
  turns: { role: "shopper" | "agent"; text: string }[];
  error: string | null;
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
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, new Date(model.lockEndsAt).getTime() - now);
  const clock = clockFrom(remaining);
  const curve = model.decision?.tradeInCurve ?? [];
  return (
    <div className="panel">
      <section className="card" role="dialog" aria-labelledby="simmer-title">
        <div className="rings" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="kicker">Marinating · example trade-in data</p>
        <h1 id="simmer-title">{model.status === "vault" ? "Covered in the Vault" : "Marinating"}</h1>
        <p>
          {model.parsedFromPage ? "Read from this Apple bag" : "Example phone — the bag could not be read"} ·{" "}
          {formatUsd(model.totalCents)}
        </p>
        <p className="fine">{model.itemNames.join(" · ")}</p>
        {model.status === "vault" ? (
          <p className="note">
            The pot stays covered until {model.vaultUntil ? new Date(model.vaultUntil).toLocaleString() : "tomorrow"}.
            Unlock stays here. It only turns Apple's own button back on after this rest, and Simmer never clicks it.
          </p>
        ) : (
          <p className="clock" aria-live="polite">
            {remaining > 0 ? clock : "0:00"}
          </p>
        )}
        {model.status !== "vault" && remaining === 0 ? (
          <p>Ten minutes are up. Unlock is still your choice. Simmer will not place the order.</p>
        ) : null}
        {model.explanation ? <p>{model.explanation}</p> : null}
        {model.reading ? <p className="fine">reading your reply...</p> : null}
        <Curve points={curve} waitMonths={model.decision?.waitMonths ?? 0} />
        <div className="row">
          <button type="button" onClick={actions.unlock}>
            Unlock
          </button>
          <button type="button" className="quiet" onClick={actions.sleep}>
            Sleep on it
          </button>
          {model.status === "vault" ? (
            <button type="button" className="quiet" onClick={actions.skipVault}>
              Demo: skip 24 hours
            </button>
          ) : null}
        </div>
        <p className="fine">Unlock only re-enables Apple's button. Cart {model.code}. Text this once: {model.linkMessage}</p>
        {model.pingDelivered ? <p>Simmer texted your linked phone.</p> : null}
        {!model.pingDelivered ? (
          <div className="note">
            <p>
              {model.pingReason === "send_failed" ? "The text did not send." : "No phone is linked yet."} Use this
              message if you want to reply from Messages.
            </p>
            {model.smsLink ? <p><a href={model.smsLink}>Open the sms: link</a></p> : null}
            {model.qrDataUrl ? <img alt="QR code that opens the cart text" src={model.qrDataUrl} width={160} height={160} /> : null}
          </div>
        ) : null}
        <h2>{UPGRADE_PROMPT}</h2>
        <ol className="turns">
          {model.turns.map((turn, index) => (
            <li key={`${turn.role}-${index}`}>{turn.text}</li>
          ))}
        </ol>
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
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="my battery dies by 3pm and I owe $420"
            aria-label="Message Simmer"
          />
          <button type="submit">Send</button>
        </form>
        {model.error ? <p role="alert">{model.error}</p> : null}
      </section>
    </div>
  );
}

function Curve({ points, waitMonths }: { points: { month: number; cents: number }[]; waitMonths: number }) {
  if (points.length < 2) {
    return null;
  }
  const width = 280;
  const height = 96;
  const max = Math.max(...points.map((point) => point.cents));
  const min = Math.min(...points.map((point) => point.cents));
  const span = Math.max(1, max - min);
  const coords = points.map((point, index) => {
    const x = 8 + (index / (points.length - 1)) * (width - 16);
    const y = 8 + (1 - (point.cents - min) / span) * (height - 16);
    return `${x},${y}`;
  });
  const laterIndex = Math.min(points.length - 1, Math.max(0, waitMonths));
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Example trade-in curve">
        <polyline points={coords.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx={coords[0]?.split(",")[0]} cy={coords[0]?.split(",")[1]} r="3.5" />
        <circle cx={coords[laterIndex]?.split(",")[0]} cy={coords[laterIndex]?.split(",")[1]} r="3.5" />
      </svg>
      <figcaption>Example data. Today versus the suggested wait.</figcaption>
    </figure>
  );
}

function clockFrom(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
