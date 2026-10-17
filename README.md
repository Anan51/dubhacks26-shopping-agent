# DubHacks 2026 shopping agent

Hello-world echo agent on **Photon 2.0 Beta** (`@photon-ai/api`, not `spectrum-ts`). When someone texts the shared iMessage line, the agent replies:

```text
hello from the shopping agent: <their text>
```

The reply string lives in [`src/reply.ts`](src/reply.ts). Both receivers call [`src/handle-message.ts`](src/handle-message.ts), which sends that string back with `POST /v1/projects/{id}/messages`.

This is a scaffold. It does not shop, call a model, or talk to a store.

Photon docs used here are the Beta set: [https://photon.codes/docs/beta/](https://photon.codes/docs/beta/).

## What you need

- Node.js **24** or later. The [project setup guide](https://photon.codes/docs/beta/get-started/project) requires it for the TypeScript walkthrough. `package.json` sets `"engines": { "node": "24.x" }` so Vercel uses that runtime. `.nvmrc` is `24`.
- A Photon Beta account at [https://photon.codes/beta](https://photon.codes/beta) (dashboard: [https://app.beta.photon.codes](https://app.beta.photon.codes)).
- An iPhone or Mac that can send a blue-bubble iMessage. The human has to text first. Shared lines are direct chats only.

## 1. Photon project and key

1. Sign in and create an organization and a project.
2. Settings: copy the Project ID (`pho_prj_...`).
3. API keys → New API key. Permissions: `project:read` and `project:write`. The key (`pho_sk_...`) is shown once.

Guide: [Set up your project](https://photon.codes/docs/beta/get-started/project).

## 2. Shared iMessage line

1. In the project, open iMessage.
2. Enter your own iMessage phone (E.164, like `+14155550123`) or Apple ID email as the test sender.
3. Assign a number from the shared pool. That number is the agent. Copy it.

Only that sender identity can reach the line. Each extra tester needs their own assignment. The free plan includes shared assignments. A shared line cannot send the first message, and it cannot do group chats.

Guide: [Build an iMessage agent](https://photon.codes/docs/beta/get-started/imessage).

## 3. Local env

```sh
cp .env.example .env
```

Fill in `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM=imessage`, `PHOTON_AGENT_HANDLE`, and `PHOTON_TEST_SENDER`. Leave `PHOTON_WEBHOOK_SECRET` empty until you register a webhook. Do not commit `.env`.

`PHOTON_API_ORIGIN` is optional and defaults to `https://api.photon.codes`.

## 4. Run the live listener

No public URL. This process holds Photon's Socket.IO connection ([live events](https://photon.codes/docs/beta/websocket/)).

```sh
npm install
npm run dev:agent
```

Wait until it prints `Connected`. From the iMessage identity you assigned, text the agent's number. You should get `hello from the shopping agent: ` plus your text.

The replay cursor stays in memory. Restarting the process does not catch texts that arrived while it was down (`startSeq` 0 means live only).

## 5. Deploy the webhook on Vercel

The same handler is a serverless POST at `/api/webhook`.

1. Import this repo in Vercel (Hobby / free tier is enough).
2. Set `PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `PHOTON_PLATFORM`, `PHOTON_AGENT_HANDLE`, and `PHOTON_TEST_SENDER`. Leave `PHOTON_WEBHOOK_SECRET` unset until the destination exists; the route returns 500 without a `whsec_` secret. Framework preset: Other. Node 24 comes from `engines`.
3. Deploy. The route is `https://<project>.vercel.app/api/webhook`.
4. In Photon, create a webhook destination for `message.received`. List selectable API versions first (`GET /v1/projects/{projectId}/webhooks/api-versions`, or `photon.projects.listWebhookApiVersions`) and use one whose `selectable` flag is true. The iMessage event schema in the current OpenAPI document is pinned to `apiVersion` `2026-07-01`; the client example also shows `2026-01-01`. Use whichever the list says you can select.

```ts
import { randomUUID } from "node:crypto";
import { Photon } from "@photon-ai/api";

const photon = new Photon({
  headers: { Authorization: `Bearer ${process.env.PHOTON_API_KEY}` },
});

const created = await photon.projects.createWebhookDestination({
  path: { projectId: process.env.PHOTON_PROJECT_ID ?? "" },
  headers: { idempotencyKey: randomUUID() },
  body: {
    apiVersion: "SELECT_A_SELECTABLE_VERSION",
    enabledEvents: ["message.received"],
    name: "dubhacks-echo",
    url: "https://<project>.vercel.app/api/webhook",
  },
});
```

5. Copy `created.signingSecret` (`whsec_...`) into `PHOTON_WEBHOOK_SECRET` on Vercel and redeploy. It is not returned again on later reads.

Creating a destination: [createWebhookDestination](https://photon.codes/docs/beta/api-client/sdk/projects/create-webhook-destination).

### Signature verification is not implemented

Beta docs say to store the signing secret for signature verification. They do not document the header name or the algorithm. The route requires `PHOTON_WEBHOOK_SECRET` to be a `whsec_` value, then accepts the JSON body **without checking a signature**. See the TODO in [`api/webhook.ts`](api/webhook.ts).

Stable Spectrum (`X-Spectrum-Signature` / `spectrum-ts`) is a different product. Do not point this route at those docs.

Until verification exists, anyone who can POST to the URL can trigger a reply. Keep the URL private.

Photon may deliver the same event more than once. Replies use idempotency key `echo:<message id>`.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

There is no Photon key in this repo, so those commands do not open a live conversation.

## Layout

| File | Role |
| --- | --- |
| `src/reply.ts` | The one function to replace with the real agent |
| `src/handle-message.ts` | Reads a `message.received` event and sends the reply |
| `src/agent.ts` | `npm run dev:agent` Socket.IO worker |
| `api/webhook.ts` | Vercel `message.received` webhook |
