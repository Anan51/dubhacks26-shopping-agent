# Accounts and memory

Email login and per-user memory are optional. With `MONGODB_URI`, `JWT_SECRET`, and `BACKBOARD_API_KEY` unset, the desk demo and the in-memory cart store run as before. These modules do not replace `WAITMATE_STORE_PATH`.

## Auth method

Simmer issues a **JWT in the httpOnly cookie `simmer_token`** (HS256, 7 days, `SameSite=Lax`). This is not a server-side session, so it does not share the cart store. Middleware also accepts `Authorization: Bearer <jwt>` for curl and other non-browser clients. `POST /auth/signup` and `POST /auth/login` return that same token in the JSON body as `token`, next to `user`.

`SESSION_SECRET` is unused while this cookie is the session.

`POST /auth/signup` and `POST /auth/login` take `{ email, password }`. Passwords are hashed with argon2id before they are stored. `GET /auth/me` reads the signed-in user from the JWT. The `User` document has `email`, `passwordHash`, an optional `backboardAssistantId`, and timestamps. There is no Google sign-in.

Both routes answer `503` with a clear message when MongoDB or `JWT_SECRET` is missing, and the process still boots. `POST /auth/logout` answers `503` when `JWT_SECRET` is unset. When the secret is set, logout clears `simmer_token` with the same Path, SameSite, and Secure attributes used to set it, and returns `{ ok: true }` without a MongoDB connection.

## Memory

Backboard scopes memory to an **assistant**, not a user. Threads on one assistant share that assistant's memories. Simmer does **not** use one shared assistant. On signup (when the API key is set) or on the first memory write, the server calls `POST /assistants` and stores `assistant_id` on that user's Mongo document.

`GET /memories`, `POST /memories`, and `POST /memories/search` take the user id from the verified JWT (`req.user.id`). A `userId` or `assistantId` in the query, body, or path is refused. Search calls Backboard with the assistant id stored on that user. The assistant id passed to Backboard is read from that Mongo user only.

Each memory is one of `regret`, `goal`, or `returned`. The text is written to that user's assistant and copied into the `MemoryNote` collection, keyed by the Mongo `_id`, so listing does not spend model credit.

The nudge hook reads that index and appends a short line to the verdict. It runs only when `BACKBOARD_API_KEY` is set, and only for a request that has `req.user`. It does **not** call `POST /threads/messages`. That endpoint defaults to `gpt-4o` and would spend the $5 free credit. `sendMessage` on the client still sends `memory: "Auto"`, `stream: false`, `model_name: "gpt-4o"`, and the stored `assistant_id` for a later, explicit recall.

When `BACKBOARD_API_KEY` is unset, the client is an in-memory stand-in and the nudge hook is not installed.

## What you need before this runs live

1. A MongoDB database and `MONGODB_URI` (`mongodb+srv://...`). The URI stays in the environment. It is not hardcoded.
2. A long random `JWT_SECRET`.
3. A Backboard API key in `BACKBOARD_API_KEY`. Create it in the Backboard dashboard. The free credit is $5 and expires in 30 days.
4. `BACKBOARD_API_URL` only if you are not using `https://app.backboard.io/api`.

No Google OAuth client is required.

Put `MONGODB_URI` in `.env`.
Run `npm run check:mongo`.
`PASS` means Atlas, auth, and memory work live.

## Confirmed Backboard contract

A live check at 10:00 PM PT on Oct 17, 2026 confirmed the rows below. Every request sent the raw `BACKBOARD_API_KEY` in `X-API-Key`. There is no key prefix and it is not a bearer token.

| Call | Live result |
| --- | --- |
| Create assistant | `POST /assistants` `{ name, system_prompt }` → 200 `{ assistant_id, name, created_at, ... }` |
| Add memory | `POST /assistants/{assistant_id}/memories` → 201 `{ success, message, memory_id, content }`. No `status` and no `memory_operation_id`. |
| Search | `POST /assistants/{assistant_id}/memories/search` `{ query, limit }` → 200 `{ memories: [{ id, content, score, created_at, updated_at }], total_count }` |
| List memories | `GET /assistants/{assistant_id}/memories` → 200 `{ memories: [{ id, content, metadata, ... }], total_count, page, ... }` |
| Delete assistant | `DELETE /assistants/{assistant_id}` → 200 `{ message, assistant_id, deleted_at }` |

A `memory_id` with no status is treated as `COMPLETED`. That memory was searchable immediately. Two assistants were isolated: the second assistant's search returned 0 hits for the first assistant's memory.

Simmer lists from the Mongo index rather than `GET /assistants/{id}/memories`. `resetMemories` still calls `DELETE /assistants/{assistant_id}/memories`, which was not part of this live check. The checked delete removes the assistant.

`POST /threads/messages` is from the docs, not this live check. The client sends the stored assistant id, `memory: "Auto"`, `stream: false`, and `model_name: "gpt-4o"`. Assistant create does not take a model. The SDK's `k` is `limit` on search.

## Regret search

Impulse scoring searches the shopper's assistant while it builds the cart reading. The score is written onto the cart before the response returns, so the search stays on that path. `REGRET_SEARCH_TIMEOUT_MS` is 3.5 seconds. Live search often takes longer than the old 1.2 second cap, which dropped real matches and left the score at 4.5. A timeout or a failed search still returns no hits, so the regret signal stays at zero and the score stays 4.5.

The cart path takes the bag category from `categoryForItem`. The phone keywords are `phone`, `iphone`, `pixel`, `galaxy`, and `smartphone`, so a Pixel 9 bag is `phone`. Search results include `content` and a `score`, not metadata. Backboard's search score is a distance: 0 is an identical memory, and unrelated text scores higher. A live check against a seeded `regretted purchase: iPhone 15 Pro (phone, $999)` memory scored the exact text at 0, `iPhone 16 Pro phone` at 0.439, `Pixel 9 phone` at 0.578, `Wool socks` at 0.883, and `banana bread recipe` at 0.924. The old 0.615 figure is a distance, not a similarity. A vote memory is already `regretted purchase: {item} ({category}, {price})`. The saved category is used when it is present. A `Regret:` line with no vote shape is mapped with `categoryForItem` from its text. A real bag category matches when the saved category equals it, or when `categoryForItem` of the memory subject equals it. An `other` bag is not a category match: it counts only when the names share a token. That category check is the first filter. `macbook` maps to `computer` (a whole-word `mac` check missed it). A Pixel 9 bag and the seeded iPhone 15 Pro regret are both `phone`, so the category gate keeps them. `REGRET_SEARCH_MAX_DISTANCE` (default `0.7`) is a second guard and a maximum distance: a hit counts only when its distance is at most that value. Live same-category matches land around 0.44–0.58, an on-record relevant match is 0.615, and unrelated hits are 0.88 or higher. A 0.6 cap would drop that 0.615 match; 0.7 keeps it and the 0.578 Pixel query, which is same-category (`phone`) and under 0.7. Closeness is `1 - score`, so a smaller distance weighs more. Set the variable to a float in `[0, 1]`. An unset or invalid value falls back to `0.7`. A hit with no numeric score still clears the distance guard, and still has to match the category.

Changing a purchase vote removes that purchase's previous vote memory, including the Backboard row when `backboardMemoryId` is set, before writing the new vote. Clearing the vote removes it and does not write another. A regretted vote is written once per purchase.

## Single-memory delete

The public API documents `DELETE /assistants/{assistant_id}/memories/{memory_id}` (one memory, database and vector store). It was not in the Oct 17 live check. When a shopper deletes a purchase and the matching `MemoryNote` has `backboardMemoryId`, and `BACKBOARD_API_KEY` is set, Simmer calls that route with the assistant id stored on the user. A failed call is logged. The Mongo purchase and the note are still removed. With the key unset, nothing is sent.

## Still unverified

`GET /assistants/memories/operations/{operation_id}` was never triggered. The live add-memory response had no operation id. The poller is unchanged for a later write that returns `memory_operation_id` with status `IN_PROGRESS`.
