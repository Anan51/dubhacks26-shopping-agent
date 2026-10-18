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

1. Open `http://127.0.0.1:4321/fallback`. If apple.com loads, you can use a signed-out bag instead: add one item, stop on the bag.
2. The overlay says **Marinating**. Check Out and Apple Pay do nothing. The Why panel names the **example trade-in bundle**, the dollar saving, and says it is example data, not a current carrier deal. The trade-in curve is labeled example data.
3. Note the cart code and the line `Text this once: link user-...`.
4. Open `http://127.0.0.1:4321/dev?cart=THATCODE`. Click **Simulate linked ping**. The stub thread gets `What's making you want to upgrade?` If you skip the link, the overlay keeps an `sms:` link and a QR code instead.
5. Back on the bag, in the box under **What's making you want to upgrade?**, send:
   `cracked screen, battery dies by 3pm, I need it for work tomorrow`
6. Why now starts with **Unlock**. It lists need, high urgency, and a broken phone, each sourced to keywords, and says the price math would have slept.
7. Send:
   `the new color looks nice`
8. Why now says this is a want with low urgency and **Sleep on it**.
9. Click **Sleep on it**. The overlay becomes **Covered in the Vault**, names the unblock time about 24 hours out, and still shows **Unlock**. Check Out is still blocked. Nothing is purchased.
10. Refresh the desk. It shows the verdict, trade-in and financing numbers, each signal with its source, and the example offer with its saving.

To show opt-out: extension options, add `127.0.0.1` (or `apple.com`), save, reload the bag. The overlay stays off and Check Out works again. Remove the line and reload to turn Simmer back on.

## Fallbacks

| What failed | What you use |
| --- | --- |
| apple.com will not load | `http://127.0.0.1:4321/fallback` — example phone, $1,200, same extension |
| Bag text cannot be read | Example $1,200 phone, labeled on the overlay |
| No phone linked, or the send fails | `sms:` link and QR code on the overlay. The body is `Hey Simmer, cart CODE` |
| No Photon key | Desk stub at `/dev`. Same agent as the live adapter |
| No `XAI_API_KEY` | Keyword parsing. The Why panel says keywords |

## Known limitations

- A real Photon in-thread send needs `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM=imessage`, and `PHOTON_AGENT_HANDLE` (the line number). This demo does not include a key, so that send is not live.
- A live Grok parse needs `XAI_API_KEY`. Without it, the two scripted replies use keywords. `npm run smoke:grok` is the one-shot live check.
- Trade-in values, the $35 financing, the $420 example balance, and the offer catalog are synthetic. They are not a current T-Mobile quote.
- The example offer appears only when waiting for it costs less than buying now. A longer financing wait that saves more keeps the financing verdict and hides the smaller offer.
- **Unlock** during the 24-hour Vault does not lift the block. **Demo: skip 24 hours** does, for the table.
- Clicking **Unlock** outside the Vault only re-enables Apple's button. Simmer does not click it.
- The extension is built for port 4321.
