import { useEffect, useState, type ReactNode } from "react";

import { navigate } from "./path.js";
import {
  buyAnyway,
  createCart,
  getCart,
  getCatalog,
  getConfig,
  getGuard,
  saveGuard,
  type CartResponse,
  type Decision,
  type GuardSettings,
  type Kind,
  type Product,
  type PublicConfig,
} from "./api.js";
import { formatClock, formatCooling, formatLongDate, formatUsd } from "./format.js";
import { guardSessionId } from "./session.js";

const DEFAULT_IDS = ["phone-n1-128", "plan-unlimited", "acc-case"];

export function Checkout({ code }: { code: string | null }) {
  const [catalog, setCatalog] = useState<Product[] | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [selected, setSelected] = useState<string[]>(DEFAULT_IDS);
  const [demo, setDemo] = useState(true);
  const [sessionId] = useState(guardSessionId);
  const [guard, setGuard] = useState<GuardSettings | null>(null);
  const [thresholdDollars, setThresholdDollars] = useState("100");
  const [cart, setCart] = useState<CartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [bypassing, setBypassing] = useState(false);

  useEffect(() => {
    let cancel = false;
    Promise.all([getCatalog(), getConfig()])
      .then(([products, nextConfig]) => {
        if (cancel) {
          return;
        }
        setCatalog(products);
        setConfig(nextConfig);
        setDemo(true);
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setError(cause instanceof Error ? cause.message : "Could not load checkout.");
        }
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    getGuard(sessionId)
      .then((loaded) => {
        if (cancel) {
          return;
        }
        setGuard(loaded.settings);
        setThresholdDollars(String(loaded.settings.thresholdCents / 100));
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setError(cause instanceof Error ? cause.message : "Could not load the guard.");
        }
      });
    return () => {
      cancel = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!code) {
      setCart(null);
      return;
    }
    let cancel = false;
    const pull = () => {
      getCart(code)
        .then((next) => {
          if (!cancel) {
            setCart(next);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!cancel) {
            setCart(null);
            setError(cause instanceof Error ? cause.message : "Cart not found.");
          }
        });
    };
    pull();
    const timer = window.setInterval(pull, 1000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [code]);

  if (!catalog || !config) {
    return <p className="status-line">{error ?? "Loading the synthetic catalog…"}</p>;
  }

  if (code && !cart && !error) {
    return <p className="status-line">Loading that cart…</p>;
  }

  if (code && cart?.status === "completed") {
    return <Receipt cart={cart} />;
  }

  if (code && cart) {
    return (
        <LockedCheckout
        cart={cart}
        channel={config.channel}
        bypassing={bypassing}
        error={error}
        onBuyAnyway={() => void skipLock(cart.code)}
      />
    );
  }

  if (code && error) {
    return (
      <section className="panel">
        <h1>Cart not found</h1>
        <p>{error}</p>
        <a className="button" href="/">
          Back to the shop
        </a>
      </section>
    );
  }

  const chosen = catalog.filter((product) => selected.includes(product.id));
  const dueToday = chosen.filter((product) => product.cadence === "once").reduce((sum, product) => sum + product.priceCents, 0);
  const monthly = chosen.filter((product) => product.cadence === "monthly").reduce((sum, product) => sum + product.priceCents, 0);
  const hasPhone = chosen.some((product) => product.kind === "phone");

  return (
    <div className="layout">
      <section>
        <h1>Take a minute before this upgrade.</h1>
        <p className="lede">{guardSummary(guard, dueToday)}</p>
        {(["phone", "plan", "accessory"] as const).map((kind) => (
          <div key={kind} className="group">
            <h2>{kindLabel(kind)}</h2>
            <div className="cards">
              {catalog
                .filter((product) => product.kind === kind)
                .map((product) => {
                  const pressed = selected.includes(product.id);
                  return (
                    <button
                      key={product.id}
                      type="button"
                      className={pressed ? "card selected" : "card"}
                      aria-pressed={pressed}
                      onClick={() => setSelected((current) => toggle(catalog, current, product))}
                    >
                      <span className="card-kind">{kindLabel(kind)}</span>
                      <span className="card-name">
                        {product.name}
                        <span>{product.detail}</span>
                      </span>
                      <span className="card-blurb">{product.blurb}</span>
                      <span className="card-price">
                        {formatUsd(product.priceCents)}
                        {product.cadence === "monthly" ? <span> / mo</span> : null}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </section>
      <aside className="summary">
        <h2>Due today</h2>
        <ul className="lines">
          {chosen.map((product) => (
            <li key={product.id}>
              <span>
                {product.name}
                <small>{product.detail}</small>
              </span>
              <span>
                {formatUsd(product.priceCents)}
                {product.cadence === "monthly" ? " / mo" : ""}
              </span>
            </li>
          ))}
        </ul>
        <p className="total">
          <span>Due today</span>
          <strong>{formatUsd(dueToday)}</strong>
        </p>
        <p className="monthly">
          Then {formatUsd(monthly)} / month
        </p>
        <p className="pay-row">Synthetic card ···· 4242</p>
        <GuardControl
          guard={guard}
          choices={config.cooldownChoicesMs}
          thresholdDollars={thresholdDollars}
          onThresholdDollars={setThresholdDollars}
          onChange={(next) => void updateGuard(next)}
        />
        <label className="demo-toggle">
          <input type="checkbox" checked={demo} onChange={(event) => setDemo(event.target.checked)} />
          Demo reminder: text me in about 1 minute instead of the real date
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button type="button" className="button" disabled={!hasPhone || buying || !guard} onClick={() => void placeOrder()}>
          {buying ? "Placing the order…" : "Buy"}
        </button>
        <p className="fine">
          {guard && willLock(guard, dueToday)
            ? `Buy starts a ${formatCooling(guard.coolingMs)} cooling-off lock. No card is charged.`
            : "Buy completes this synthetic order. No card is charged."}
        </p>
      </aside>
    </div>
  );

  async function updateGuard(next: GuardSettings): Promise<void> {
    setGuard(next);
    try {
      setGuard(await saveGuard(sessionId, next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the guard.");
    }
  }

  async function placeOrder(): Promise<void> {
    if (!guard) {
      return;
    }
    setBuying(true);
    setError(null);
    try {
      const next = await createCart(selected, demo, sessionId, guard);
      setCart(next);
      navigate(`/c/${next.code}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start checkout.");
    } finally {
      setBuying(false);
    }
  }

  async function skipLock(cartCode: string): Promise<void> {
    setBypassing(true);
    setError(null);
    try {
      setCart(await buyAnyway(cartCode));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not complete the order.");
    } finally {
      setBypassing(false);
    }
  }
}

function LockedCheckout({
  cart,
  channel,
  bypassing,
  error,
  onBuyAnyway,
}: {
  cart: CartResponse;
  channel: PublicConfig["channel"];
  bypassing: boolean;
  error: string | null;
  onBuyAnyway: () => void;
}) {
  const remaining = useRemaining(cart.coolingOffEndsAt);
  const duration = new Date(cart.coolingOffEndsAt).getTime() - new Date(cart.createdAt).getTime();
  const progress = duration > 0 ? remaining / duration : 0;
  const dueToday = cart.items.filter((item) => item.cadence === "once").reduce((sum, item) => sum + item.priceCents, 0);

  return (
    <div className="layout">
      <section>
        <h1>Cooling-off lock</h1>
        <p className="lede">Cart {cart.code} is held until WaitMate clears it, or you buy anyway.</p>
        <ul className="lines frozen">
          {cart.items.map((item) => (
            <li key={item.id}>
              <span>
                {item.name}
                <small>
                  {item.detail} · {kindWord(item.kind)}
                </small>
              </span>
              <span>
                {formatUsd(item.priceCents)}
                {item.cadence === "monthly" ? " / mo" : ""}
              </span>
            </li>
          ))}
        </ul>
        <p className="total">
          <span>Due today</span>
          <strong>{formatUsd(dueToday)}</strong>
        </p>
      </section>
      <aside className="summary lock">
        <Clock remaining={remaining} progress={progress} />
        {cart.decision ? <Why cart={cart} /> : <p>Text WaitMate the cart code. It will ask a few questions before it picks buy or wait.</p>}
        {error ? <p className="form-error">{error}</p> : null}
        <TextActions cart={cart} channel={channel} bypassing={bypassing} onBuyAnyway={onBuyAnyway} />
      </aside>
    </div>
  );
}

function Clock({ remaining, progress }: { remaining: number; progress: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(1, Math.max(0, progress)));
  const label = remaining > 0 ? `${formatClock(remaining)} remaining in the cooling-off lock` : "Cooling-off clock has run out";
  return (
    <div className="clock-wrap" role="timer" aria-label={label}>
      <svg className="ring" viewBox="0 0 140 140" aria-hidden="true">
        <circle className="ring-track" cx="70" cy="70" r={radius} />
        <circle
          className="ring-value"
          cx="70"
          cy="70"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <p className="clock" aria-hidden="true">
        {remaining > 0 ? formatClock(remaining) : "0:00"}
      </p>
      <p className="clock-note">
        {remaining > 0
          ? "The purchase stays locked while this runs."
          : "The clock has run out. The order still waits on WaitMate."}
      </p>
    </div>
  );
}

function Why({ cart }: { cart: CartResponse }) {
  const decision = cart.decision;
  if (!decision) {
    return null;
  }
  return (
    <div className={verdictClass(decision.action)}>
      <p className="why-kicker">{verdictKicker(decision.action)}</p>
      <dl className="figures">
        <div>
          <dt>Out of pocket today</dt>
          <dd>{formatUsd(decision.netNowCents)}</dd>
        </div>
        <div>
          <dt>In {decision.horizonMonths} months</dt>
          <dd>{formatUsd(decision.netLaterCents)}</dd>
        </div>
        <div>
          <dt>Trade-in</dt>
          <dd>
            {formatUsd(decision.tradeInNowCents)} → {formatUsd(decision.tradeInLaterCents)}
          </dd>
        </div>
        <div>
          <dt>Still owed</dt>
          <dd>
            {formatUsd(decision.owedNowCents)} → {formatUsd(decision.owedLaterCents)}
          </dd>
        </div>
      </dl>
      {cart.explanation ? <p className="explanation">{cart.explanation}</p> : null}
      {verdictNote(cart)}
    </div>
  );
}

function TextActions({
  cart,
  channel,
  bypassing,
  onBuyAnyway,
}: {
  cart: CartResponse;
  channel: PublicConfig["channel"];
  bypassing: boolean;
  onBuyAnyway: () => void;
}) {
  return (
    <div className="actions">
      {cart.smsLink ? (
        <a className="button" href={cart.smsLink}>
          Text WaitMate
        </a>
      ) : (
        <a className="button" href={cart.deskPath}>
          Text WaitMate
        </a>
      )}
      {cart.smsLink ? (
        <a className="button quiet" href={cart.deskPath}>
          No iPhone handy? Use desk chat
        </a>
      ) : (
        <p className="fine">
          {channel === "stub"
            ? "Photon isn’t connected, so this opens the desk chat with your cart code ready to send."
            : "Desk chat uses the same agent without iMessage."}
        </p>
      )}
      <button type="button" className="button quiet" onClick={onBuyAnyway} disabled={bypassing}>
        {bypassing ? "Completing the order…" : "Buy anyway"}
      </button>
      <p className="code-line">
        Cart code <strong>{cart.code}</strong>
      </p>
    </div>
  );
}

function GuardControl({
  guard,
  choices,
  thresholdDollars,
  onThresholdDollars,
  onChange,
}: {
  guard: GuardSettings | null;
  choices: number[];
  thresholdDollars: string;
  onThresholdDollars: (value: string) => void;
  onChange: (next: GuardSettings) => void;
}) {
  return (
    <fieldset className="guard" disabled={!guard}>
      <legend>WaitMate guard</legend>
      <label className="demo-toggle">
        <input
          type="checkbox"
          checked={guard?.enabled ?? true}
          onChange={(event) => {
            if (guard) {
              onChange({ ...guard, enabled: event.target.checked });
            }
          }}
        />
        On
      </label>
      <label className="guard-row">
        Threshold ($)
        <input
          type="number"
          min={0}
          step={1}
          inputMode="decimal"
          value={thresholdDollars}
          onChange={(event) => {
            onThresholdDollars(event.target.value);
            if (!guard || event.target.value.trim() === "") {
              return;
            }
            const dollars = Number(event.target.value);
            if (!Number.isFinite(dollars) || dollars < 0) {
              return;
            }
            onChange({ ...guard, thresholdCents: Math.round(dollars * 100) });
          }}
        />
      </label>
      <label className="guard-row">
        Cooldown
        <select
          value={guard?.coolingMs ?? 600_000}
          onChange={(event) => {
            if (guard) {
              onChange({ ...guard, coolingMs: Number(event.target.value) });
            }
          }}
        >
          {choices.map((ms) => (
            <option key={ms} value={ms}>
              {ms / 60_000} min
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

function willLock(guard: GuardSettings | null, dueTodayCents: number): boolean {
  return Boolean(guard?.enabled) && dueTodayCents >= (guard?.thresholdCents ?? 0);
}

function guardSummary(guard: GuardSettings | null, dueTodayCents: number): string {
  if (!guard) {
    return "Loading the WaitMate guard.";
  }
  if (!guard.enabled) {
    return "The guard is off, so Buy completes this synthetic order.";
  }
  if (dueTodayCents < guard.thresholdCents) {
    return "This cart is under the threshold, so Buy completes this synthetic order.";
  }
  return `The guard is on, so Buy starts a ${formatCooling(guard.coolingMs)} cooling-off lock.`;
}

function Receipt({ cart }: { cart: CartResponse }) {
  const dueToday = cart.items.filter((item) => item.cadence === "once").reduce((sum, item) => sum + item.priceCents, 0);
  return (
    <section className="receipt">
      <p className="why-kicker">Mock order</p>
      <h1>Order {cart.orderId}</h1>
      <p className="lede">Checkout unlocked. This receipt is synthetic — no payment was sent.</p>
      <ul className="lines">
        {cart.items.map((item) => (
          <li key={item.id}>
            <span>
              {item.name}
              <small>{item.detail}</small>
            </span>
            <span>
              {formatUsd(item.priceCents)}
              {item.cadence === "monthly" ? " / mo" : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="total">
        <span>Due today</span>
        <strong>{formatUsd(dueToday)}</strong>
      </p>
      <a className="button quiet" href="/">
        Start another cart
      </a>
    </section>
  );
}

function verdictClass(action: Decision["action"]): string {
  switch (action) {
    case "buy":
      return "why buy";
    case "wait":
      return "why";
    default:
      return assertNever(action);
  }
}

function verdictKicker(action: Decision["action"]): string {
  switch (action) {
    case "buy":
      return "WaitMate says buy";
    case "wait":
      return "WaitMate says wait";
    default:
      return assertNever(action);
  }
}

function verdictNote(cart: CartResponse): ReactNode {
  const decision = cart.decision;
  if (!decision) {
    return null;
  }
  switch (decision.action) {
    case "wait":
      return cart.reminderAt ? (
        <p className="reminder-note">
          Reminder date: {formatLongDate(cart.reminderAt)}
          {cart.demo ? " · demo mode texts you in about a minute." : "."}
        </p>
      ) : null;
    case "buy":
      return cart.status !== "completed" ? (
        <p className="reminder-note">Reply YES in the chat to unlock this checkout.</p>
      ) : null;
    default:
      return assertNever(decision.action);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

function useRemaining(endsAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, new Date(endsAt).getTime() - now);
}

function toggle(catalog: Product[], current: string[], product: Product): string[] {
  if (product.kind === "accessory") {
    return current.includes(product.id) ? current.filter((id) => id !== product.id) : [...current, product.id];
  }
  const rest = current.filter((id) => catalog.find((item) => item.id === id)?.kind !== product.kind);
  return [...rest, product.id];
}

function kindWord(kind: Kind): string {
  switch (kind) {
    case "phone":
      return "Phone";
    case "plan":
      return "Plan";
    case "accessory":
      return "Accessory";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function kindLabel(kind: Kind): string {
  switch (kind) {
    case "phone":
      return "Phones";
    case "plan":
      return "Plans";
    case "accessory":
      return "Accessories";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
