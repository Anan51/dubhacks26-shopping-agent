import { Checkout } from "./Checkout.js";
import { DevChat } from "./DevChat.js";
import { cartCode, usePath } from "./path.js";

export function App() {
  const path = usePath();
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <p className="synthetic" role="note">
        SYNTHETIC DATA — fictional phones, plans, and prices for a hackathon demo. Not a real store. No card will be
        charged.
      </p>
      <header className="top">
        <a className="wordmark" href="/">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
          </span>
          WaitMate
        </a>
        <nav>
          <a href="/" aria-current={path.startsWith("/c/") || path === "/" ? "page" : undefined}>
            Checkout
          </a>
          <a href="/dev" aria-current={path.startsWith("/dev") ? "page" : undefined}>
            Desk chat
          </a>
        </nav>
      </header>
      <main id="main">
        {path.startsWith("/dev") ? <DevChat /> : <Checkout code={cartCode(path)} />}
      </main>
    </>
  );
}

