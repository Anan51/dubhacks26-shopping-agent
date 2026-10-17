import { useEffect, useState, type ReactNode } from "react";

import { navigate } from "./path.js";
import {
  createCart,
  getCart,
  getCatalog,
  getConfig,
  type CartResponse,
  type Decision,
  type Kind,
  type Product,
  type PublicConfig,
} from "./api.js";
import { formatClock, formatCooling, formatLongDate, formatUsd } from "./format.js";

const DEFAULT_IDS = ["phone-n1-128", "plan-unlimited", "acc-case"];

export function Checkout({ code }: { code: string | null }) {
  const [catalog, setCatalog] = useState<Product[] | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [selected, setSelected] = useState<string[]>(DEFAULT_IDS);
  const [demo, setDemo] = useState(true);
  const [cart, setCart] = useState<CartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);

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
    return <LockedCheckout cart={cart} channel={config.channel} />;
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
        <p className="lede">
          Buy starts a {formatCooling(config.coolingMs)} cooling-off lock. WaitMate asks about the phone you already
          have, then says buy or wait in plain language.
        </p>
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
        <label className="demo-toggle">
          <input type="checkbox" checked={demo} onChange={(event) => setDemo(event.target.checked)} />
          Demo reminder: text me in about 1 minute instead of the real date
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button type="button" className="button" disabled={!hasPhone || buying} onClick={() => void placeOrder()}>
          {buying ? "Starting the lock…" : "Buy"}
        </button>
        <p className="fine">Buy does not charge the card. It starts the cooling-off lock.</p>
      </aside>
    </div>
  );

  async function placeOrder(): Promise<void> {
    setBuying(true);
    setError(null);
    try {
      const next = await createCart(selected, demo);
      setCart(next);
      navigate(`/c/${next.code}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the lock.");
    } finally {
      setBuying(false);
    }
  }
}

function LockedCheckout({ cart, channel }: { cart: CartResponse; channel: PublicConfig["channel"] }) {
  const remaining = useRemaining(cart.coolingOffEndsAt);
  const duration = new Date(cart.coolingOffEndsAt).getTime() - new Date(cart.createdAt).getTime();
  const progress = duration > 0 ? remaining / duration : 0;
  const dueToday = cart.items.filter((item) => item.cadence === "once").reduce((sum, item) => sum + item.priceCents, 0);

  return (
    <div className="layout">
      <section>
        <h1>Cooling-off lock</h1>
        <p className="lede">Cart {cart.code} is held. Checkout unlocks only after you confirm a buy with WaitMate.</p>
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
        <TextActions cart={cart} channel={channel} />
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

function TextActions({ cart, channel }: { cart: CartResponse; channel: PublicConfig["channel"] }) {
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
      <p className="code-line">
        Cart code <strong>{cart.code}</strong>
      </p>
    </div>
  );
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
