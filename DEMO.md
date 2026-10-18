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

The extension only matches the Apple bag, Apple checkout hosts, and `http://127.0.0.1:4321/fallback` (plus `/fallback/cable` and localhost).

Unknown extension users use the **Impulsive** mock history (impulse score 2). `user-deliberate` starts at 4. On `/dev`, the Persona menu switches the open bag between those two seeds. Purchase score = impulse + justification grade, clamped to 1–5.

Necessity and the grade call Grok only when `XAI_API_KEY` is set (model `grok-4.20-0309-non-reasoning`, 8s). With the key empty, or if the call fails, both use keywords. The desk labels each one `grok` or `keywords`.

## Click-by-click script

Stay signed out. Do not enter a card. Do not go past the checkout entry.

1. Open `http://127.0.0.1:4321/fallback/cable`. The corner card says **Necessary buy** and **Checkout can proceed**. Check Out and Apple Pay work. Simmer does not click them. The desk necessity row says `necessary (keywords)` unless Grok is configured.
2. Open `http://127.0.0.1:4321/fallback` (Example phone, $1,200). The corner card says **Marinating**, with a countdown, **Unlock**, and **Why**. Check Out and Apple Pay do nothing.
3. Click the Simmer toolbar icon. The popup header says **Marinating**. The card says `Example phone` · `$1,200` · `Impulse 2 · need a reason`. Click the card. The breakdown shows impulse 2 from mock history, and the example trade-in alternative only because waiting for it costs less than buying now. That line says example data, not a current carrier deal.
4. Open `http://127.0.0.1:4321/dev`. Persona is **Impulsive · score 2**, with the mock purchases. Click **Simulate linked ping**. The stub thread gets `What's making you want to upgrade?` Photon sends that when a line is configured. With no key, this stub is the send. If you skip the link, **Why** on the bag has the `sms:` link.
5. On the bag, open **Why** and send:
   `the new color looks nice`
   Keywords grade that **-2**. Score is `2 + -2`, clamped to **1** (strict). The corner card says **In the Vault**. The popup card says `Score 1 · Vault · 24h left`. **Unlock** does not lift it. Why lists the required 24-hour limit and the alternative (wait, dollars, example offer). The desk grade source says `keywords`.
6. Open Why and click **Demo: skip 24 hours**. The bag is Marinating again. Check Out stays blocked.
7. Send:
   `I need it for work`
   Keywords grade that **+1**. Score is **3** (soft). The popup card says `Score 3 · Sleep on it`. Why shows the same alternative and says the pause is optional. Click **Sleep on it**. The popup card says `Score 3 · optional pause`. **Unlock** can lift this one. Leave it up for the next reply.
8. Send:
   `cracked screen, battery dies by 3pm, I need it for work tomorrow`
   Keywords grade that **+3**. Score is **5** (free). The card goes away and Apple's button works. Simmer does not click it. The page note appears only after you press Check Out yourself.
9. Refresh the desk. It shows necessity, impulse, grade, purchase score, each source, the trade-in and financing numbers, and the example offer when that offer beats buying now.

To see the deliberate seed: on `/dev`, set Persona to **Deliberate · score 4** before a reply. The same color line then scores `4 + -2` = **2** (soft) instead of 1. The history list changes with the menu.

To show opt-out: extension options, add `127.0.0.1` (or `apple.com`), save, reload the bag. The overlay stays off and Check Out works again. Remove the line and reload to turn Simmer back on.

## Fallbacks

| What failed | What you use |
| --- | --- |
| apple.com will not load | `http://127.0.0.1:4321/fallback` — example phone, $1,200, unnecessary, same extension |
| Need a necessary buy | `http://127.0.0.1:4321/fallback/cable` — USB-C charge cable, $19, no lock |
| Bag text cannot be read | Example $1,200 phone, labeled on the overlay, classified unnecessary |
| No phone linked, or the send fails | `sms:` link inside Why. The QR is on the desk. The body is `Hey Simmer, cart CODE` |
| No Photon key | Desk stub at `/dev`. Same justification text as the live adapter |
| No `XAI_API_KEY`, or Grok fails | Keyword necessity and keyword grade. The desk says `keywords`. Grok runs only when the key is set |

## Known limitations

- A real Photon in-thread send needs `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM=imessage`, and `PHOTON_AGENT_HANDLE` (the line number). This demo does not include a key, so that send is not live.
- A live Grok necessity check or grade needs `XAI_API_KEY`. Without it, both use keywords. `npm run smoke:grok` is the one-shot live check for signal extraction.
- Impulse scores come from two mock histories in `src/history.ts`: Impulsive is 2, Deliberate is 4. They are not a model of a real shopper.
- Trade-in values, the $35 financing, the $420 example balance, and the offer catalog are synthetic. They are not a current T-Mobile quote. `decide()` still produces that alternative for scores 1 and 2–3.
- The example offer appears only when waiting for it costs less than buying now.
- Score 1 is a required 24-hour vault. **Unlock** does not lift it. **Demo: skip 24 hours** does.
- Score 2–3 offers **Sleep on it**. That pause is optional, and **Unlock** lifts it.
- Score 4 or 5 unlocks the bag. Simmer does not click Apple's button.
- The extension is built for port 4321.
