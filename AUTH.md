# Accounts and memory

Email login and per-user memory are optional. With `MONGODB_URI`, `JWT_SECRET`, and `BACKBOARD_API_KEY` unset, the desk demo and the in-memory cart store run as before. These modules do not replace `WAITMATE_STORE_PATH`.

## Auth method

Simmer issues a **JWT in the httpOnly cookie `simmer_token`** (HS256, 7 days, `SameSite=Lax`). This is not a server-side session, so it does not share the cart store. Middleware also accepts `Authorization: Bearer <jwt>` for curl and other non-browser clients. The token is not returned in the JSON body.

`SESSION_SECRET` is unused while this cookie is the session.

`POST /auth/signup` and `POST /auth/login` take `{ email, password }`. Passwords are hashed with argon2id before they are stored. The `User` document has `email`, `passwordHash`, an optional `backboardAssistantId`, and timestamps. There is no Google sign-in.

Both routes answer `503` with a clear message when MongoDB or `JWT_SECRET` is missing, and the process still boots.

## Memory

Backboard scopes memory to an **assistant**, not a user. Threads on one assistant share that assistant's memories. Simmer does **not** use one shared assistant. On signup (when the API key is set) or on the first memory write, the server calls `POST /assistants` and stores `assistant_id` on that user's Mongo document.

`GET /memories` and `POST /memories` take the user id from the verified JWT (`req.user.id`). A `userId` or `assistantId` in the query, body, or path is refused. The assistant id passed to Backboard is read from that Mongo user only.

Each memory is one of `regret`, `goal`, or `returned`. The text is written to that user's assistant and copied into the `MemoryNote` collection, keyed by the Mongo `_id`, so listing does not spend model credit.

The nudge hook reads that index and appends a short line to the verdict. It runs only when `BACKBOARD_API_KEY` is set, and only for a request that has `req.user`. It does **not** call `POST /threads/messages`. That endpoint defaults to `gpt-4o` and would spend the $5 free credit. `sendMessage` on the client still sends `memory: "Auto"`, `stream: false`, `model_name: "gpt-4o"`, and the stored `assistant_id` for a later, explicit recall.

When `BACKBOARD_API_KEY` is unset, the client is an in-memory stand-in and the nudge hook is not installed.

## What you need before this runs live

1. A MongoDB database and `MONGODB_URI` (`mongodb+srv://...`). The URI stays in the environment. It is not hardcoded.
2. A long random `JWT_SECRET`.
3. A Backboard API key in `BACKBOARD_API_KEY`. Create it in the Backboard dashboard. The free credit is $5 and expires in 30 days.
4. `BACKBOARD_API_URL` only if you are not using `https://app.backboard.io/api`.

No Google OAuth client is required.

## Confirmed Backboard contract

Taken from [docs.backboard.io](https://docs.backboard.io) and the integration notes:

| Call | Request |
| --- | --- |
| Create assistant | `POST /assistants` `{ name, system_prompt }` → `assistant_id` |
| Add memory | `POST /assistants/{assistant_id}/memories` `{ content, metadata? }` |
| Operation status | `GET /assistants/memories/operations/{operation_id}` → `COMPLETED`, `IN_PROGRESS`, or `ERROR` |
| Search | `POST /assistants/{assistant_id}/memories/search` `{ query, limit }` |
| Send message | `POST /threads/messages` `{ content, assistant_id, memory: "Auto", stream: false, model_name: "gpt-4o" }` |
| Reset | `DELETE /assistants/{assistant_id}/memories` |

Every request sends `X-API-Key`. Not `Authorization: Bearer`.

Memory writes are asynchronous. A path that recalls immediately polls the operation until it settles.

Assistant create does not take a model. `gpt-4o` is the documented default on send message, and the client sets `model_name` there. The SDK's `searchMemories(assistantId, query, k)` is the search endpoint above; `k` is `limit` on the wire.

## Still unverified

- **API key prefix.** The docs show the raw key in `X-API-Key` and do not document a prefix. The client sends `BACKBOARD_API_KEY` unchanged.
- **Add-memory response fields.** The published OpenAPI schema for that 201 is an open object. The client reads `memory_id`, `memory_operation_id`, and `status` from the integration notes, and treats a present `memory_id` with no status as `COMPLETED`.
