# WaitMate

Anti-impulse checkout for DubHacks 2026. A synthetic phone shop starts a 10-minute cooling-off lock, then WaitMate asks a few questions and gives a buy-or-wait call. The call is a deterministic heuristic. An optional model can only rephrase it.

Tracks: Visa-style checkout, T-Mobile Timekeeper (honest “don’t upgrade yet” costs), and Photon 2.0 messaging.

Built on the Photon 2.0 echo scaffold. The live listener still uses `@photon-ai/api` and Socket.IO. `POST /api/webhook` is still there for a Vercel deploy.

## Demo without a Photon key

Node 22 or newer is enough locally. `package.json` still asks Vercel for Node 24.

```sh
npm install
npm run dev
```

Open http://localhost:4321.

1. The shop is prefilled with a synthetic phone, plan, and case. The **WaitMate guard** starts on, at $100 due today, with a 10-minute cooldown. Leave **Demo reminder** checked. The prefilled cart is over $100, so it locks.
2. Press **Buy**. Over the threshold, the page shows a countdown. Under the threshold, or with the guard off, Buy completes the synthetic order with no lock. **Buy anyway** on the lock screen completes it and records that on the cart.
3. Press **Text WaitMate**. With no Photon number configured, that opens the desk chat and prefills `Hey WaitMate, cart ABCDEF`. Each cart has its own thread.
4. Send that text, then answer the questions (or press **Run wait script** / **Run buy script**).
5. **Wait** saves the cart and, in demo mode, texts a checkout link into the same desk chat about a minute later.
6. **Buy** asks you to reply `YES`. The checkout page polls and shows a mock receipt. Nothing is charged.
7. **Run better script**, or answer the problem question with `my battery dies by 3pm`. WaitMate should say Better and name the $89 battery swap. The checkout shows that synthetic alternative and **Switch to this**. Without `XAI_API_KEY` the same phrase is parsed with keywords. `npm run smoke:grok` calls Grok once where the key exists and prints the signals, not the key.

The banner says **SYNTHETIC DATA**. Product names (Northstar, Harbor, Lumen, Signal) are fictional.

### Scripts

Wait, on the preselected cart:

```text
14 months
it works fine
420
1500
```

Buy:

```text
38 months
screen is cracked and the battery dies by 3pm
0
2000
YES
```

## Demo with Photon

You need a Photon 2.0 project and a shared iMessage assignment. The human has to text first. Docs: https://photon.codes/docs/beta/

```sh
cp .env.example .env
```

Fill in `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM=imessage`, `PHOTON_AGENT_HANDLE`, and `PHOTON_TEST_SENDER`. Then:

```sh
npm run dev
```

The server connects to Photon’s Socket.IO live events. No public URL. **Text WaitMate** becomes an `sms:` link to `PHOTON_AGENT_HANDLE` with the cart code in the body. Messages on that line hit the same agent as the desk chat. Desk chat stays available if a judge has no iPhone.

Set `WAITMATE_PUBLIC_ORIGIN` to the origin you want inside reminder texts. At the table that is usually `http://localhost:4321`.

`WAITMATE_CHANNEL=stub` forces the desk chat even if keys are present. `WAITMATE_CHANNEL=photon` refuses to boot without the four Photon variables.

## What is stubbed

- Payments, inventory, and the catalog. No carrier quotes.
- The desk chat (`/dev`) stands in for iMessage until a Photon key is set.
- Trade-in values are a fixed curve in `src/heuristic.ts`, and the payoff math assumes $35 a month.
- Demo mode compresses the reminder to about a minute (`WAITMATE_DEMO_REMINDER_MS`, default 60000). The date in the message is still six months out.
- `XAI_API_KEY` is optional. If it is unset, or Grok changes the buy/wait call, the template is sent. The key never goes in git.
- The webhook still does not verify Photon’s signature. Beta docs don’t name the header or algorithm. See the TODO in `api/webhook.ts`.

Shopper text becomes signals only in `extractSignals` (`src/extract-signals.ts`). `decide` does not read raw text. Phrasing does not choose the call. A later change can replace the keyword extractor with Grok (`XAI_API_KEY`) without rewriting the heuristic.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm start
```

`npm start` serves `web/dist` and expects `npm run build` first.

## Layout

| File | Role |
| --- | --- |
| `src/extract-signals.ts` | Free text → signals (Grok JSON, then keywords) |
| `src/alternatives.ts` | Synthetic cheaper fixes |
| `src/heuristic.ts` | `decide(signals)` buy-or-wait call |
| `src/phrase.ts` | Template, plus optional Grok wording |
| `src/conversation.ts` | Questions, confirm, save, unlock |
| `src/server.ts` | Express + Vite checkout + Photon listener |
| `src/channels/photon.ts` | Socket.IO adapter |
| `web/` | React checkout and desk chat |
| `api/webhook.ts` | Vercel `message.received` route |

Carts, desk transcripts, and guard settings live in the process store. The default is in-memory. Set `WAITMATE_STORE_PATH` to use a JSON file instead. A Vercel webhook is a separate process, so it does not see carts created on the laptop.

## Photon, not verified here

There is no Photon key in this environment, so the live socket, shared iMessage line, and webhook delivery were not exercised against `api.photon.codes`. The listener and the `message.received` parser are the scaffold’s, including `data.object` from the Beta OpenAPI schema. Signature verification is still unimplemented. Sending still uses `POST /v1/projects/{id}/messages` with an idempotency key.
