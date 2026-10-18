# Backboard live category proof for PR #36 (head 1450b75)

- **Run:** 2026-10-18, 03:23:15–03:23:22 PDT (America/Los_Angeles)
- **Branch / head:** `cursor/regret-search-category-timeout-6acb` @ `1450b758eba6929170e913aa3a93d16afc036b9d`
- **Runtime:** Node v24.22.0, tsx. The client is the real `HttpBackboardClient` (`https://app.backboard.io/api`) from `createBackboardClient(env)`, with `remote: true`. The user store was mongodb-memory-server 7.0.14, because Atlas isn't reachable from the box.
- **API key:** [REDACTED]. It was loaded into the process env only, and was never printed, logged or committed.
- **Code path:** `computeImpulseScore(userId, bag, { weeklyBudget: null }, { backboardEnabled: true, client })` with the defaults `REGRET_SEARCH_TIMEOUT_MS = 3500` and `DEFAULT_REGRET_SEARCH_MAX_DISTANCE = 0.6`. The live run at head 1450b75 used that 0.6 max-distance cap, which is what the '≤ 0.6?' column reflects. The user had no budget, hours or goals, so the regret search is the only thing that can move the score. The default was raised to 0.7 later at head `7d1d1ba` for headroom over the 0.615 on-record match and the 0.578 Pixel, still well below the 0.88 unrelated floor.
- **Cleanup:** The seeded memory was deleted and the throwaway assistant was deleted. Both calls succeeded.

## Why the score is treated as a distance

Backboard's docs call `score` a **"Relevance score for the search result (can be null)"**. The list, get and update schemas describe it as "Relevance score for search results". The docs example shows the top hit at 0.95 and the second at 0.87. That reads like higher means closer. Source: https://docs.backboard.io/api-reference/memories/search (schema also at https://docs.backboard.io/api-reference/memories/list), fetched 2026-10-18.

The live API behaves the other way: **lower means closer**. In a live check on 2026-10-18 at about 03:13 PDT (same key, a throwaway assistant holding two memories), these were the scores:

| Query | `iPhone 15 Pro` memory | `Wool socks` memory |
|---|---|---|
| exact text of the iPhone memory | **0** | 0.4563458 |
| `iPhone 15 Pro` | 0.4374116 | 0.894325 |
| `iPhone 16 Pro phone` | 0.4392047 | 0.90213305 |
| `Pixel 9 phone` | 0.5780583 | 0.9089259 |
| `Wool socks apparel` | 0.8833047 | 0.4661488 |
| `Wool socks other` | 0.8872187 | 0.3988589 |
| `banana bread recipe` | 0.92408866 | 0.89199275 |
| `quarterly tax filing deadline` | 0.92468363 | 0.9104123 |

An identical memory scores 0. Matching items score about 0.40–0.58, and unrelated text scores about 0.88–0.92. That is a distance. The doc example (0.95 at the top) doesn't match what this account's API actually returns. At the time of this run (1450b75) the default `REGRET_SEARCH_MAX_DISTANCE` was 0.6, so a hit counted only when `score <= 0.6`, and each counted hit was weighted by `1 - score`. The category check still runs first. The default was raised to 0.7 later at head `7d1d1ba` for headroom over the 0.615 on-record match and the 0.578 Pixel, still well below the 0.88 unrelated floor. The outcomes are identical under both caps: the near hit 0.439 counts either way and 0.883 is dropped on category.

At head 2ec9930, which treated the score as a similarity with a 0.5 floor, the same near bag stayed at **4.5 on 5/5 runs**: its 0.439 hit was dropped.

## Setup

| Role | Item | `categoryForItem` |
|---|---|---|
| Seeded regret memory | `regretted purchase: iPhone 15 Pro (phone, $999)` (write COMPLETED in 1216 ms, searchable on the first poll) | phone |
| NEAR bag | `iPhone 16 Pro` (query `iPhone 16 Pro phone`) | phone |
| UNRELATED bag | `Wool socks` (query `Wool socks apparel`) | other |

## Per-run results (live, head 1450b75)

| Run | Bag | Search latency (ms) | Hit (memory category) | Raw score (distance) | Same category? | ≤ 0.6? | Counted? | Impulse |
|---|---|---|---|---|---|---|---|---|
| 1 | NEAR | 170 | iPhone 15 Pro (phone) | 0.43920094 | yes | yes | **yes** | **4.9** |
| 2 | NEAR | 163 | iPhone 15 Pro (phone) | 0.43920094 | yes | yes | **yes** | **4.9** |
| 3 | NEAR | 168 | iPhone 15 Pro (phone) | 0.43920094 | yes | yes | **yes** | **4.9** |
| 4 | NEAR | 156 | iPhone 15 Pro (phone) | 0.43920094 | yes | yes | **yes** | **4.9** |
| 5 | NEAR | 169 | iPhone 15 Pro (phone) | 0.43920094 | yes | yes | **yes** | **4.9** |
| 1 | UNRELATED | 564 | iPhone 15 Pro (phone) | 0.8833047 | no (other vs phone) | no | no | 4.5 |
| 2 | UNRELATED | 154 | iPhone 15 Pro (phone) | 0.8833047 | no (other vs phone) | no | no | 4.5 |
| 3 | UNRELATED | 165 | iPhone 15 Pro (phone) | 0.8833047 | no (other vs phone) | no | no | 4.5 |
| 4 | UNRELATED | 153 | iPhone 15 Pro (phone) | 0.8833047 | no (other vs phone) | no | no | 4.5 |
| 5 | UNRELATED | 166 | iPhone 15 Pro (phone) | 0.8833047 | no (other vs phone) | no | no | 4.5 |

Every search returned exactly one hit. There were no timeouts and no search errors. Latency ranged from 153 to 564 ms, well under the 3.5 s timeout. A separate check on 2026-10-18 saw 783–1373 ms, and one of those calls went over the old 1.2 s cap. The near bag's reason was "You regretted a similar purchase before." The unrelated bag's reason was null.

Here is how the near score works out: 4.5 + 0.7 × (1 − 0.43920094) = 4.8926, which rounds to **4.9** (`clampImpulseScale` rounds to 0.1).

## Conclusion

**PASS:** At head 1450b75, against live Backboard, the same-category near bag raises the score to 4.9 on 5/5 runs, and the cross-category unrelated bag stays at 4.5 on 5/5 runs.
