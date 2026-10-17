import { useEffect, useState } from "react";

import { getTranscript, sendDeskMessage, type TranscriptTurn } from "./api.js";

const STORAGE_KEY = "waitmate-desk-id";

export function DevChat() {
  const cart = cartFromLocation();
  const [conversationId] = useState(deskId);
  const [draft, setDraft] = useState(cart ? `Hey WaitMate, cart ${cart}` : "");
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancel = false;
    const pull = () => {
      getTranscript(conversationId)
        .then((next) => {
          if (!cancel) {
            setTurns(next);
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

  return (
    <div className="desk">
      <section>
        <h1>Desk chat</h1>
        <p className="lede">
          This is the stub channel. It runs the same agent as Photon, with no API key. On a real iPhone you’d text the
          shared line first — the human has to message before WaitMate can reply.
        </p>
        <div className="scripts">
          <h2>Demo scripts</h2>
          <p>Use the cart code from checkout. Wait saves the cart and texts a reminder. Buy asks you to confirm.</p>
          <div className="script-row">
            <button type="button" className="button quiet" disabled={!cart || busy} onClick={() => void run(waitScript(cart ?? ""))}>
              Run wait script
            </button>
            <button type="button" className="button quiet" disabled={!cart || busy} onClick={() => void run(buyScript(cart ?? ""))}>
              Run buy script
            </button>
          </div>
          {!cart ? <p className="fine">Open this page from Text WaitMate so the cart code is in the link.</p> : null}
        </div>
      </section>
      <section className="thread" aria-live="polite">
        <h2 className="sr-only">Conversation</h2>
        {turns.length === 0 ? <p className="fine">No messages yet.</p> : null}
        <ol>
          {turns.map((turn, index) => (
            <li key={`${turn.role}-${index}`} className={turn.role === "shopper" ? "bubble mine" : "bubble"}>
              <span className="who">{turn.role === "shopper" ? "You" : "WaitMate"}</span>
              {turn.text}
            </li>
          ))}
        </ol>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) {
              void run([draft.trim()]);
              setDraft("");
            }
          }}
        >
          <label htmlFor="desk-text">Message</label>
          <textarea
            id="desk-text"
            value={draft}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
          />
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" className="button" disabled={busy || draft.trim().length === 0}>
            {busy ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </div>
  );

  async function run(lines: string[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      let next: TranscriptTurn[] = [];
      for (const line of lines) {
        next = await sendDeskMessage(conversationId, line);
        setTurns(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Message failed.");
    } finally {
      setBusy(false);
    }
  }
}

function waitScript(code: string): string[] {
  return [`Hey WaitMate, cart ${code}`, "14 months", "it works fine", "420", "1500"];
}

function buyScript(code: string): string[] {
  return [
    `Hey WaitMate, cart ${code}`,
    "38 months",
    "screen is cracked and the battery dies by 3pm",
    "0",
    "2000",
    "YES",
  ];
}

function cartFromLocation(): string | null {
  const value = new URLSearchParams(window.location.search).get("cart")?.toUpperCase() ?? "";
  return /^[A-HJ-NP-Z2-9]{6}$/.test(value) ? value : null;
}

function deskId(): string {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing && /^desk:[A-Za-z0-9-]{8,80}$/.test(existing)) {
    return existing;
  }
  const created = `desk:${crypto.randomUUID()}`;
  window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}
