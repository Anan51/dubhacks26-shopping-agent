# Simmer

Simmer marinates an Apple bag before checkout. A Chrome extension pauses **Check Out** and **Apple Pay**, reads the product name and bag total, and asks why the shopper wants it. The verdict compares buying now with waiting: trade-in decay plus remaining financing. Both of those are example data. Simmer never clicks Apple's button and never places an order.

Env vars stay `WAITMATE_*`. Renaming them would break an existing `.env` for no product change.

## Run

```bash
npm install
npm test
npm run dev
```

Open the desk at [http://127.0.0.1:4321/dev](http://127.0.0.1:4321/dev). Leave Photon blank. The desk is the stub phone.

`npm run typecheck` and `npm run build` compile the server, the desk, and the extension.

## Load the extension

1. `npm run build`
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked**
3. Choose `extension/dist`
4. Options: local server `http://127.0.0.1:4321`. apple.com is on until you add it to the off list.

The manifest matches the Apple bag (`/shop/bag`, including regional paths), `secure*.store.apple.com` checkout URLs, and `http://127.0.0.1:4321/fallback` plus localhost. It does not match the rest of apple.com.

## Demo

1. Stay signed out of Apple. Do not enter a card. Do not go past the checkout entry.
2. Add one item and open the bag. Simmer covers the page with **Marinating**, steam rings, and a 10-minute timer. Unlock stays visible. It only re-enables Apple's own button.
3. The overlay shows the product name and total. If the page cannot be read, Simmer uses an example $1,200 phone.
4. Reply in the overlay, or text `link <id>` once so a later checkout can ping that thread. With no Photon key, the desk simulates a linked ping and a failed send (sms link plus QR).
5. **Sleep on it** covers the bag for 24 hours. The Vault still shows **Unlock**. Unlock does not lift the Vault early. **Demo: skip 24 hours** does, for the table.
6. If apple.com will not load, open [http://127.0.0.1:4321/fallback](http://127.0.0.1:4321/fallback). That page is example data and the same extension path. It is not the main demo.

`/api/pay` only reports the lock for the desk. It does not charge anyone.

## What is stubbed

- Photon send is behind the adapter. Desk ids are stored locally. There is no Photon key in this environment, so the live in-thread send is not verified.
- Grok runs when `XAI_API_KEY` is set (`XAI_MODEL` empty uses `grok-4.20-0309-non-reasoning`, timeout `XAI_TIMEOUT_MS` or 8 seconds). No key means keywords. `npm run smoke:grok` calls the API once and prints signals, never the key.
- Trade-in values and the $35 financing balance are example data, labeled on screen.
- The store is in memory unless `WAITMATE_STORE_PATH` is set.
