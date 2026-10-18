# Simmer demo runbook

Three minutes, no Photon key and no Grok key. The desk at `/dev` is the phone. Simmer never clicks Apple's button and never takes a card.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`. Leave every value empty for this demo. `PHOTON_PLATFORM` must be `imessage` only when you later connect a real line.
3. `npm test`
4. `npm run build`
5. `npm run dev`
6. Chrome → `chrome://extensions` → Developer mode → Load unpacked → `extension/dist`
7. Extension options: local server `http://127.0.0.1:4321`. Leave the opt-out list empty. apple.com is on until you add it.

The extension only matches the Apple bag, Apple checkout hosts, and `http://127.0.0.1:4321/fallback` (plus localhost).

## Click-by-click script

Stay signed out. Do not enter a card. Do not go past the checkout entry.

These two replies use the **keyword** fallback. Grok runs only when `XAI_API_KEY` is set. With the key empty, Why and the desk say `keywords`.

1. Open `http://127.0.0.1:4321/fallback`. If apple.com loads, you can use a signed-out bag instead: add one item, stop on the bag.
2. A corner card says **Marinating**, shows a countdown, **Unlock**, and **Why**. Check Out and Apple Pay do nothing. The long read is not on the page until you open Why.
3. Click the Simmer toolbar icon. The popup header says **Marinating**. The card is the bag: name, price, and one line such as `Wait ~2 mo, save ~$557`. Click that card. The breakdown shows the wait, the dollars saved, trade-in decay, financing, and the example trade-in bundle only if waiting for it costs less than buying now. That offer line says example data, not a current carrier deal.
4. Open `http://127.0.0.1:4321/dev`. The cart dropdown has the same bag. Click **Simulate linked ping**. The stub thread gets `What's making you want to upgrade?` If you skip the link, open **Why** on the bag: the `sms:` link is there.
5. On the bag, click **Why**. In the box under **What's making you want to upgrade?**, send:
   `cracked screen, battery dies by 3pm, I need it for work tomorrow`
6. The verdict flips to Unlock. Open the toolbar popup: that card's line is **Buy now**. Why lists need, high urgency, and a broken phone, each marked `keywords`, and the desk reply starts with **Unlock**. The price math would have slept. Check Out is still blocked. The corner card stays **Marinating** with the countdown until you vault or unlock.
7. Send:
   `the new color looks nice`
8. The verdict is Sleep. Why shows want and low urgency, marked `keywords`.
9. In that Why panel, click **Sleep on it**. The corner card and the popup header say **In the Vault**. The popup card says `Vault · 24h left` (or the hours remaining). **Unlock** stays visible. Check Out stays blocked. Nothing is purchased.
10. Open Why and click **Demo: skip 24 hours**. The vault time lifts and the bag is Marinating again. Then click **Unlock**. The card goes away and Apple's button works. Simmer does not click it. The page result appears only after you press Check Out yourself.
11. Refresh the desk. It shows the verdict, trade-in and financing numbers, each signal with its source, and the example offer when that offer beats buying now.

To show opt-out: extension options, add `127.0.0.1` (or `apple.com`), save, reload the bag. The overlay stays off and Check Out works again. Remove the line and reload to turn Simmer back on.

## Fallbacks

| What failed | What you use |
| --- | --- |
| apple.com will not load | `http://127.0.0.1:4321/fallback` — example phone, $1,200, same extension |
| Bag text cannot be read | Example $1,200 phone, labeled on the overlay |
| No phone linked, or the send fails | `sms:` link inside Why. The QR is on the desk. The body is `Hey Simmer, cart CODE` |
| No Photon key | Desk stub at `/dev`. Same agent as the live adapter |
| No `XAI_API_KEY` | Keyword parsing for both scripted replies. Why and the desk say `keywords`. Grok runs only when the key is set |

## Known limitations

- A real Photon in-thread send needs `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM=imessage`, and `PHOTON_AGENT_HANDLE` (the line number). This demo does not include a key, so that send is not live.
- A live Grok parse needs `XAI_API_KEY`. Without it, the two scripted replies use keywords. `npm run smoke:grok` is the one-shot live check.
- Trade-in values, the $35 financing, the $420 example balance, and the offer catalog are synthetic. They are not a current T-Mobile quote.
- The example offer appears only when waiting for it costs less than buying now. A longer financing wait that saves more keeps the financing verdict and hides the smaller offer.
- **Unlock** during the 24-hour Vault does not lift the block. **Demo: skip 24 hours** does, for the table.
- Clicking **Unlock** outside the Vault only re-enables Apple's button. Simmer does not click it.
- The extension is built for port 4321.
