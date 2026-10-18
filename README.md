# Simmer

Simmer marinates an Apple bag before checkout. A Chrome extension pauses **Check Out** and **Apple Pay**, reads the product name and bag total, and asks why the shopper wants it. The verdict compares buying now with waiting: trade-in decay plus remaining financing. Both of those are example data. Simmer never clicks Apple's button and never places an order.

Env vars stay `WAITMATE_*`. Renaming them would break an existing `.env` for no product change.

## Run

```bash
npm install
npm test
npm run dev
```

`npm test` does not launch a browser. `npm run test:zoom` installs Chromium and checks the card at several zoom levels. See [TESTING.md](TESTING.md).

Leave Photon blank until you connect an iMessage line. Replies that unlock a bag are graded iMessage texts.

The server listens on 127.0.0.1 unless `HOST` is set. The extension and `npm run dev:demo` still use `http://localhost:4321`.

`npm run typecheck` and `npm run build` compile the server, the desk, and the extension.

## Demo mode

Demo mode is off unless you opt in.

- `npm run dev:demo` starts the server with `WAITMATE_DEMO=1` and without `NODE_ENV=production`. That allows `POST /api/dev/reply`, which simulates an iMessage reply for a cart from typed text or a preset. With the flag unset, or in production, that route returns 404. It does not call Photon.
- `npm run build:demo` builds the extension with `VITE_SIMMER_DEMO=1`. That build shows a Simulate reply control. The default `npm run build` does not set the flag, and the control is left out of `extension/dist`.
- `PHOTON_TEST_NUMBER` is the demo recipient (E.164). `.env.example` uses the placeholder `+15555550100`. Do not commit a real number.

## Load the extension

1. `npm run build`
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked**
3. Choose `extension/dist`
4. Options: local server `http://127.0.0.1:4321`. apple.com is on until you add it to the off list.

The manifest matches the Apple bag (`/shop/bag`, including regional paths), `secure*.store.apple.com` checkout URLs, and `http://127.0.0.1:4321/fallback` plus localhost. It does not match the rest of apple.com.

## Demo

1. Stay signed out of Apple. Do not enter a card. Do not go past the checkout entry.
2. Add one item and open the bag. Simmer covers the page with **Marinating**, steam rings, and a 10-minute timer. Reply to Simmer's iMessage to unlock. Simmer does not click Apple's button.
3. The overlay shows the product name and total. If the page cannot be read, it says **Couldn't read bag**.
4. Text `link <userId>` once so a later checkout can reach that iMessage thread.
5. **Sleep on it** shows only for a score of 2 or 3. **Demo: end the pause** (demo build) ends a pause and leaves the bag locked. Neither one unlocks checkout. A graded reply shows Skip, Wait, or Buy. An unnecessary bag with no reply unlocks by itself when the countdown runs out (0:00, which is 60s in demo mode), unless a vault is active, in which case it stays locked. A reply plus **Unlock** also opens it. A low score never unlocks it. Score 1 does not open a 24-hour vault.
6. If apple.com will not load, open [http://127.0.0.1:4321/fallback](http://127.0.0.1:4321/fallback). That page is example data and the same extension path. It is not the main demo.

`/api/pay` only reports the lock for the desk. It does not charge anyone.

## What is stubbed

- Photon send is behind the adapter. Desk ids are stored locally. There is no Photon key in this environment, so the live in-thread send is not verified.
- Grok runs when `XAI_API_KEY` is set (`XAI_MODEL` empty uses `grok-4.20-0309-non-reasoning`, timeout `XAI_TIMEOUT_MS` or 8 seconds). No key means keywords. `npm run smoke:grok` calls the API once and prints signals, never the key.
- Trade-in values and the $35 financing balance are example data, labeled on screen.
- The store is in memory unless `WAITMATE_STORE_PATH` is set.
- Email login and Backboard memory stay off until `MONGODB_URI`, `JWT_SECRET`, and `BACKBOARD_API_KEY` are set. See [AUTH.md](AUTH.md).
