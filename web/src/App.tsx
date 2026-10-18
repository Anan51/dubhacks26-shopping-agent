import { Desk } from "./Desk.js";

export function App() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <p className="synthetic" role="note">
        EXAMPLE DATA — trade-in values and financing are synthetic. Simmer reads an Apple bag and never places the
        order.
      </p>
      <header className="top">
        <a className="wordmark" href="/">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
          </span>
          Simmer
        </a>
        <nav>
          <a href="/" aria-current="page">
            Simmer
          </a>
        </nav>
      </header>
      <main id="main">
        <Desk />
      </main>
    </>
  );
}
