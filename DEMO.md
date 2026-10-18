# Simmer demo runbook

Three minutes, no Grok key. Replies happen in iMessage. Simmer never clicks Apple's button and never takes a card.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`. Leave every value empty for this demo. `PHOTON_PLATFORM` must be `imessage` only when you later connect a real line.
3. `npm test`
4. `npm run build`
5. `npm run dev`
6. Chrome → `chrome://extensions` → Developer mode → Load unpacked → `extension/dist`
7. Extension options: local server `http://127.0.0.1:4321`. Leave the opt-out list empty. apple.com is on until you add it.

The extension only matches the Apple bag, Apple checkout hosts, Amazon cart and checkout, and `http://127.0.0.1:4321/fallback` (plus `/fallback/cable`, `/amazon`, and localhost).

A shopper with nothing on file starts at impulsiveness **4.5** of 8 (soft). The legacy base added to the grade is **2**. Purchase score = that base + justification grade, clamped to 1–5. The corner card does not show `Impulsiveness N of 8`. That sentence is in the explanation after a non-zero grade.

Necessity and the grade call Grok only when `XAI_API_KEY` is set (model `grok-4.20-0309-non-reasoning`, 8s). With the key empty, or if the call fails, both use keywords.

## Click-by-click script

Stay signed out. Do not enter a card. Do not go past the checkout entry.

1. Open `http://127.0.0.1:4321/fallback/cable`. The corner card says **Necessary buy** and **Checkout can proceed**. Check Out and Apple Pay work. Simmer does not click them.
2. Open `http://127.0.0.1:4321/fallback` (Example phone, $1,200). The header says **Simmer · example data**. The card says **Marinating**, with a countdown and **Why**. Check Out and Apple Pay do nothing. There is no Unlock button and no message box.
3. Click the Simmer toolbar icon. The popup header says **Marinating**. The card says `Example phone` · `$1,200` · `Reply and say why you want this.`
4. If the phone is not linked, the card says to text `link <userId>` to Simmer's iMessage number. Reply in that iMessage thread. The overlay says **Reply to Simmer's iMessage to unlock.**
5. Text:
   `the new color looks nice`
   Keywords grade that **-2**. Starting impulsiveness is **4.5** of 8 (soft), so the legacy base is **2**. Purchase score = `2 + -2`, clamped to **1** (strict). Advice on the card is **Skip** (`Skip. This looks like a want, not a need. This one can wait.`). The explanation says `Impulsiveness 4.5 of 8`. The corner card does not. It stays **Marinating**, and the status line says **This one can wait.** Checkout stays blocked. Score 1 does not open a 24-hour vault, and the title does not become **Paused**. **Sleep on it** is not shown. A low score does not unlock an unnecessary bag. **Why** is one plain sentence plus the price now.
6. **Demo: end the pause** stays hidden after that reply, because the bag is not paused. The button only ends a pause that is already open, and it leaves checkout locked.
7. Text:
   `I need it for work`
   Keywords grade that **+1**. Score is **3** (soft). Advice is **Wait**. The status line says **Worth a pause before buying.** **Sleep on it** is shown for this score. It does not unlock checkout.
8. Text:
   `cracked screen, battery dies by 3pm, I need it for work tomorrow`
   Keywords grade that **+3**. Score is **5** (free). Advice is **Buy**, and the card shows that Buy line. The corner card stays **Marinating**. Checkout stays locked until you press **Unlock**, after the advice has been sent. **Sleep on it** is not shown. Simmer does not click Apple's button.

A real Apple bag uses the header **Simmer** until the fallback page is showing example data. If the bag cannot be read, the card says **Couldn't read bag** and Simmer does not invent an example phone.

## Simulate reply

Demo only. `npm run dev:demo` sets `WAITMATE_DEMO=1` and does not set `NODE_ENV=production`, which opens `POST /api/dev/reply` with `{ "code", "text" }`. With the flag off, or in production, that route returns 404. `npm run build:demo` sets `VITE_SIMMER_DEMO=1` and renders the control. `npm run build` leaves it out.

The control sends typed text or a preset. The text is graded on the same inbound path as a Photon iMessage reply. Photon is not called, and no iMessage is sent. With nothing on file, impulsiveness starts at **4.5** of 8 (soft) and the legacy base is **2**.

| Preset | Keyword grade | Purchase score | Band | Card |
| --- | --- | --- | --- | --- |
| `new color looks nice` | -2 | 1 | strict | **Skip. This looks like a want, not a need. This one can wait.** Explanation adds `Impulsiveness 4.5 of 8`. The card does not. |
| `cracked screen` | 0, so no purchase score | unchanged | unchanged | **Wait. Your current phone is broken. Give it a little time before you check out.** No impulsiveness line. |
| `I need it for work tomorrow` | +2 | 4 | free | **Buy. This looks like a need. You can check out after you press Unlock.** Explanation adds `Impulsiveness 4.5 of 8`. The card does not. |

To show opt-out: extension options, add `127.0.0.1` (or `apple.com`), save, reload the bag. The overlay stays off and Check Out works again. Remove the line and reload to turn Simmer back on.

## Fallbacks

| What failed | What you use |
| --- | --- |
| apple.com will not load | `http://127.0.0.1:4321/fallback` — example phone, $1,200, unnecessary, same extension |
| amazon.com should not be opened | `http://127.0.0.1:4321/amazon` — headphones and a case, $51.98, same card and the same checkout gate. The page does not continue to Amazon |
| Need a necessary buy | `http://127.0.0.1:4321/fallback/cable` — USB-C charge cable, $19, no lock |
| Bag text cannot be read | The overlay says **Couldn't read bag**. No example phone is created |
| No phone linked | The overlay says to text `link <userId>` to Simmer's iMessage number |
| No Photon key | iMessage replies are not delivered. The demo needs a configured line |
| No `XAI_API_KEY`, or Grok fails | Keyword necessity and keyword grade. The desk says `keywords`. Grok runs only when the key is set |

## Known limitations

- A real Photon in-thread send needs `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM=imessage`, and `PHOTON_AGENT_HANDLE` (the line number). This demo does not include a key, so that send is not live.
- A live Grok necessity check or grade needs `XAI_API_KEY`. Without it, both use keywords. `npm run smoke:grok` is the one-shot live check for signal extraction.
- A shopper with nothing on file starts at impulsiveness 4.5 of 8 (soft). The legacy base used in the purchase score is 2. The two mock histories in `src/history.ts` are still on the desk; they are not the starting 1–8 score.
- Trade-in values, the $35 financing, the $420 example balance, and the offer catalog are synthetic. They are not a current T-Mobile quote. `decide()` still produces that alternative for scores 1 and 2–3.
- The example offer appears only when waiting for it costs less than buying now.
- Purchase score = legacy base + justification grade, clamped to 1–5. `scoreBucket` is strict below 2, soft from 2 through 3, and free from 4 up. Advice is **Skip** for strict, **Wait** for soft, and **Buy** for free. A non-zero grade writes `Impulsiveness 4.5 of 8` into the explanation. The corner card shows the Skip, Wait, or Buy line, not that sentence.
- Score 1 (strict) is **Skip**. The status line is **This one can wait.** The bag stays Marinating. It does not enter a 24-hour vault, and the title does not become **Paused**. A low score does not unlock an unnecessary bag. **Sleep on it** is not shown.
- Score 2–3 (soft) is **Wait**. **Sleep on it** is shown only for that band. The pause is optional and does not unlock checkout.
- Score 4 or 5 (free) is **Buy**. Checkout stays locked until **Unlock**, after the advice has been sent. Simmer does not click Apple's button.
- A necessary bag unlocks with no reply. An unnecessary bag with no reply unlocks by itself when the countdown runs out (0:00, which is 60s in demo mode), unless a vault is active, in which case it stays locked. A reply plus **Unlock** also opens it. A low score never unlocks it. **Demo: end the pause** ends an open pause and leaves checkout locked.
- The extension is built for port 4321.
