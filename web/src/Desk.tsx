import { useEffect, useState } from "react";

import { pausedLinkLine } from "../../src/links.js";
import {
  getConfig,
  listCarts,
  readPayGate,
  resetDemo,
  setPersona,
  type CartResponse,
  type Decision,
  type PayGate,
  type PublicConfig,
} from "./api.js";
import { Curve } from "./Curve.js";
import { formatLongDate, formatUsd } from "./format.js";

export function Desk() {
  const [carts, setCarts] = useState<CartResponse[]>([]);
  const [selected, setSelected] = useState<string>(() => new URLSearchParams(window.location.search).get("cart") ?? "");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [gate, setGate] = useState<PayGate | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cart = carts.find((item) => item.code === selected) ?? carts[0] ?? null;

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
          setCarts(next.carts);
          setReadError(next.readError);
          setSelected((current) => (next.carts.some((item) => item.code === current) ? current : next.carts[0]?.code || ""));
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

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      const next = await listCarts();
      setCarts(next.carts);
      setReadError(next.readError);
      setSelected((current) => (next.carts.some((item) => item.code === current) ? current : next.carts[0]?.code || ""));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="desk">
      <section>
        <h1>Simmer</h1>
        <p className="lede">
          Internal view of the current bag. Replies happen in iMessage. No order is placed here. If apple.com will not
          load, the fallback bag is at /fallback.
        </p>
        <button
          type="button"
          className="button quiet"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await resetDemo();
            })
          }
        >
          Reset demo
        </button>
        {config ? (
          <p className="fine">
            Channel {config.channel}. Lock {Math.round(config.lockMs / 60000)} minutes. Example balance{" "}
            {formatUsd(config.exampleOwedCents)}. Fallback bag {formatUsd(config.fallbackTotalCents)}.
            {config.grokEnabled ? " Grok is on." : " Grok key is empty, so parsing stays on keywords."}
          </p>
        ) : null}
        {readError ? <p role="alert">Couldn't read bag</p> : null}
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
              <option value="impulsive">Example history: frequent buyer · score 2</option>
              <option value="deliberate">Deliberate · score 4</option>
            </select>
          </label>
        ) : null}
        {cart ? <MathPanel cart={cart} gate={gate} personas={config?.personas ?? []} /> : null}
        {error ? <p role="alert">{error}</p> : null}
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
        {cart.parsedFromPage ? "Parsed from the Apple bag" : "Couldn't read bag"} ·{" "}
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
        /api/pay {gate ? `${gate.httpStatus} ${gate.reason ?? "open"}` : "…"}. A graded iMessage reply unlocks the bag.
        This endpoint only reports the lock.
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
      {cart.vaultUntil ? <p>Paused until {formatLongDate(cart.vaultUntil)}.</p> : null}
      <p>
        Link once: <code>{cart.linkMessage}</code>
      </p>
      {cart.lastPing?.delivered ? <p>Last ping landed in the linked thread.</p> : null}
      {cart.lastPing && !cart.lastPing.delivered ? (
        <p>
          Ping {cart.lastPing.reason}. {pausedLinkLine(cart.linkMessage, config?.agentHandle ?? null)}
        </p>
      ) : null}
    </div>
  );
}
