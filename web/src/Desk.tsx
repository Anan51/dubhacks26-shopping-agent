import { useEffect, useState } from "react";

import {
  getConfig,
  getTranscript,
  linkDesk,
  listCarts,
  notifyCart,
  readPayGate,
  sendDeskMessage,
  setPersona,
  type CartResponse,
  type Decision,
  type PayGate,
  type PublicConfig,
  type TranscriptTurn,
} from "./api.js";
import { Curve } from "./Curve.js";
import { formatLongDate, formatUsd } from "./format.js";

export function Desk() {
  const [carts, setCarts] = useState<CartResponse[]>([]);
  const [selected, setSelected] = useState<string>(() => new URLSearchParams(window.location.search).get("cart") ?? "");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [gate, setGate] = useState<PayGate | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [reading, setReading] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cart = carts.find((item) => item.code === selected) ?? null;
  const conversationId = cart ? `desk:cart-${cart.code}` : "";

  useEffect(() => {
    let cancel = false;
    getConfig()
      .then((next) => {
        if (!cancel) {
          setConfig(next);
        }
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setError(cause instanceof Error ? cause.message : "Could not load config.");
        }
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    const pull = () => {
      listCarts()
        .then((next) => {
          if (cancel) {
            return;
          }
          setCarts(next);
          setSelected((current) => current || next[0]?.code || "");
        })
        .catch((cause: unknown) => {
          if (!cancel) {
            setError(cause instanceof Error ? cause.message : "Could not load carts.");
          }
        });
    };
    pull();
    const timer = window.setInterval(pull, 1500);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!cart) {
      return;
    }
    let cancel = false;
    readPayGate(cart.code)
      .then((next) => {
        if (!cancel) {
          setGate(next);
        }
      })
      .catch(() => {
        if (!cancel) {
          setGate(null);
        }
      });
    return () => {
      cancel = true;
    };
  }, [cart]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    let cancel = false;
    const pull = () => {
      getTranscript(conversationId)
        .then((next) => {
          if (!cancel) {
            setTurns(next.turns);
            setReading(next.reading);
          }
        })
        .catch((cause: unknown) => {
          if (!cancel) {
            setError(cause instanceof Error ? cause.message : "Could not load the chat.");
          }
        });
    };
    pull();
    const timer = window.setInterval(pull, 1000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [conversationId]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      setCarts(await listCarts());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="desk">
      <section>
        <h1>Desk</h1>
        <p className="lede">
          Simmer marinates the Apple bag in the browser extension. This page is the hidden math and the stub phone. No
          order is placed here. If apple.com will not load, use the fallback bag at /fallback.
        </p>
        {config ? (
          <p className="fine">
            Channel {config.channel}. Lock {Math.round(config.lockMs / 60000)} minutes. Example balance{" "}
            {formatUsd(config.exampleOwedCents)}. Fallback bag {formatUsd(config.fallbackTotalCents)}.
            {config.grokEnabled ? " Grok is on." : " Grok key is empty, so parsing stays on keywords."}
          </p>
        ) : null}
        {carts.length === 0 ? <p>Open an Apple bag with the extension loaded. Nothing is locked yet.</p> : null}
        {carts.length > 0 ? (
          <label>
            Cart
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              {carts.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} · {formatUsd(item.totalCents)} · {item.status}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {cart ? (
          <label>
            Persona
            <select
              value={cart.personaId ?? "impulsive"}
              onChange={(event) => {
                const persona = event.target.value === "deliberate" ? "deliberate" : "impulsive";
                const userId = cart.userId;
                if (!userId) {
                  return;
                }
                void run(() => setPersona(userId, persona));
              }}
            >
              <option value="impulsive">Impulsive · score 2</option>
              <option value="deliberate">Deliberate · score 4</option>
            </select>
          </label>
        ) : null}
        {cart ? <MathPanel cart={cart} gate={gate} personas={config?.personas ?? []} /> : null}
        {cart ? (
          <div className="script-row">
            <button
              type="button"
              className="button quiet"
              disabled={busy || !cart.userId}
              onClick={() =>
                void run(async () => {
                  if (!cart.userId) {
                    return;
                  }
                  await linkDesk(cart.userId, conversationId);
                  await notifyCart(cart.code, false);
                })
              }
            >
              Simulate linked ping
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={busy}
              onClick={() => void run(() => notifyCart(cart.code, true).then(() => undefined))}
            >
              Simulate send failure
            </button>
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>
      <section className="thread" aria-live="polite">
        <h2>Stub phone</h2>
        {turns.length === 0 ? <p className="fine">No messages yet.</p> : null}
        <ol>
          {turns.map((turn, index) => (
            <li key={`${turn.role}-${index}`} className={turn.role === "shopper" ? "bubble mine" : "bubble"}>
              <span className="who">{turn.role === "shopper" ? "You" : "Simmer"}</span>
              {turn.text}
            </li>
          ))}
          {reading || (busy && config?.grokEnabled) ? (
            <li className="bubble reading">reading your reply...</li>
          ) : null}
        </ol>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || !conversationId) {
              return;
            }
            setDraft("");
            void run(async () => {
              setTurns(await sendDeskMessage(conversationId, text));
            });
          }}
        >
          <label htmlFor="desk-text">Message</label>
          <textarea
            id="desk-text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={cart ? `cart ${cart.code} my battery dies by 3pm` : "Waiting for a cart"}
          />
          <button className="button" type="submit" disabled={busy || !cart}>
            Send
          </button>
        </form>
      </section>
    </div>
  );
}

function effectSentence(effect: Decision["signalEffect"]): string {
  switch (effect) {
    case "need_unlock":
      return "A needed, broken phone with high urgency unlocked it.";
    case "want_sleep":
      return "A want with low urgency kept it marinating.";
    case "math":
      return "The motive signals did not override the price math.";
    default: {
      const unreachable: never = effect;
      return unreachable;
    }
  }
}

function MathPanel({
  cart,
  gate,
  personas,
}: {
  cart: CartResponse;
  gate: PayGate | null;
  personas: PublicConfig["personas"];
}) {
  const decision = cart.decision;
  const persona = personas.find((item) => item.id === (cart.personaId ?? "impulsive")) ?? null;
  const gradeText =
    cart.justificationGrade == null
      ? "not graded"
      : `${cart.justificationGrade > 0 ? "+" : ""}${cart.justificationGrade} (${cart.gradeSource ?? "keywords"})${cart.gradeReason ? `. ${cart.gradeReason}` : ""}`;
  return (
    <div className="math">
      <h2>
        {cart.code} · {cart.status}
      </h2>
      <p>
        {cart.parsedFromPage ? "Parsed from the Apple bag" : "Example phone — the bag could not be read"} ·{" "}
        {formatUsd(cart.totalCents)}
        {cart.pageHost ? ` · ${cart.pageHost}` : ""}
      </p>
      <ul>
        {cart.items.map((item) => (
          <li key={item.name}>
            {item.name} — {item.detail}
          </li>
        ))}
      </ul>
      <p>
        /api/pay {gate ? `${gate.httpStatus} ${gate.reason ?? "open"}` : "…"}. Unlock stays on the extension. This
        endpoint only reports the lock.
      </p>
      {persona ? (
        <div>
          <p>
            Mock history · {persona.label} · impulse {persona.impulseScore}. Switch the persona above before the reply
            if you want the other score.
          </p>
          <ul>
            {persona.history.map((purchase) => (
              <li key={purchase.item}>
                {purchase.item} · {formatUsd(purchase.cents)} · {purchase.waited ? "waited" : "bought now"} ·{" "}
                {purchase.note} Mock data.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <table>
        <tbody>
          <tr>
            <th>Necessity</th>
            <td>
              {cart.necessity ?? "unclassified"} ({cart.necessitySource ?? "keywords"})
              {cart.necessityReason ? `. ${cart.necessityReason}` : ""}
            </td>
          </tr>
          <tr>
            <th>Impulse</th>
            <td>{cart.userImpulseScore ?? "—"} (mock history)</td>
          </tr>
          <tr>
            <th>Grade</th>
            <td>{gradeText}</td>
          </tr>
          <tr>
            <th>Purchase score</th>
            <td>
              {cart.purchaseScore ?? "—"}
              {cart.scoreBucket ? ` · ${cart.scoreBucket}` : ""}
              {cart.scoreReason ? `. ${cart.scoreReason}` : ""}
            </td>
          </tr>
        </tbody>
      </table>
      {decision ? (
        <>
          <table>
            <tbody>
              <tr>
                <th>Verdict</th>
                <td>
                  {decision.action} · {decision.waitMonths} months · saves {formatUsd(decision.savingsCents)}
                </td>
              </tr>
              <tr>
                <th>Buy now</th>
                <td>{formatUsd(decision.costNowCents)}</td>
              </tr>
              <tr>
                <th>Later</th>
                <td>{formatUsd(decision.costLaterCents)}</td>
              </tr>
              <tr>
                <th>Trade-in</th>
                <td>
                  {formatUsd(decision.tradeInNowCents)} now, {formatUsd(decision.tradeInLaterCents)} later
                </td>
              </tr>
              <tr>
                <th>Financing</th>
                <td>
                  {formatUsd(decision.financingNowCents)} owed, {formatUsd(decision.financingLaterCents)} later
                </td>
              </tr>
              <tr>
                <th>Inputs</th>
                <td>
                  age {cart.signals.deviceAgeMonths ?? "—"} months, {cart.signals.condition ?? "—"}, owe{" "}
                  {formatUsd(cart.signals.owedCents ?? 0)}
                </td>
              </tr>
              <tr>
                <th>Need vs want</th>
                <td>
                  {cart.signals.needVsWant ?? "unknown"} ({cart.motiveSources?.needVsWant ?? cart.signalSource ?? "default"})
                </td>
              </tr>
              <tr>
                <th>Urgency</th>
                <td>
                  {cart.signals.urgency ?? "medium"} ({cart.motiveSources?.urgency ?? cart.signalSource ?? "default"})
                </td>
              </tr>
              <tr>
                <th>Phone broken</th>
                <td>
                  {cart.signals.currentPhoneBroken ? "yes" : "no"} ({cart.motiveSources?.currentPhoneBroken ?? cart.signalSource ?? "default"})
                </td>
              </tr>
              <tr>
                <th>Reason</th>
                <td>
                  {cart.signals.reasonText || "none"} ({cart.motiveSources?.reasonText ?? cart.signalSource ?? "default"})
                </td>
              </tr>
              {decision.offerName && decision.savingsCents > 0 ? (
                <tr>
                  <th>Example offer</th>
                  <td>
                    Waiting for the {decision.offerName} saves {formatUsd(decision.savingsCents)}. Example data, not a
                    current T-Mobile or carrier deal.
                  </td>
                </tr>
              ) : null}
              <tr>
                <th>Why it moved</th>
                <td>
                  Price math said {decision.mathAction}
                  {decision.mathAction === "sleep" ? ` (${formatUsd(decision.mathSavingsCents)} over ${decision.mathWaitMonths} months)` : ""}.{" "}
                  {effectSentence(decision.signalEffect)} Verdict: {decision.action}.
                </td>
              </tr>
            </tbody>
          </table>
          <Curve points={decision.tradeInCurve} waitMonths={decision.waitMonths} />
          {cart.explanation ? <p className="explanation">{cart.explanation}</p> : null}
        </>
      ) : (
        <p>No verdict yet.</p>
      )}
      {cart.vaultUntil ? <p>Vault until {formatLongDate(cart.vaultUntil)}.</p> : null}
      <p>
        Link once: <code>{cart.linkMessage}</code>
      </p>
      {cart.lastPing?.delivered ? <p>Last ping landed in the linked thread.</p> : null}
      {cart.lastPing && !cart.lastPing.delivered ? (
        <div>
          <p>
            Ping {cart.lastPing.reason}. Fallback message: {cart.lastPing.prefilled}
          </p>
          {cart.lastPing.smsLink ? <p><a href={cart.lastPing.smsLink}>Open the sms: link</a></p> : null}
          {cart.lastPing.qrDataUrl ? <img alt="QR code for the cart text" src={cart.lastPing.qrDataUrl} width={180} height={180} /> : null}
        </div>
      ) : null}
    </div>
  );
}
