# Signed webhook triggers

`POST /api/webhook/trigger` lets an external service start a ForgeDeck blueprint without a dashboard login. Set `FORGEDECK_WEBHOOK_SECRET` and restart ForgeDeck to enable the endpoint; when it is unset, the endpoint returns `503 WEBHOOK_NOT_CONFIGURED`.

## Prerequisites

- A [blueprint](blueprints.md) defined in ForgeDeck (e.g. "Release agent")
- The blueprint's workspace root listed in `FORGEDECK_ROOTS`
- `FORGEDECK_WEBHOOK_SECRET` set to a random value in your environment

Send JSON with this shape:

```json
{
  "blueprint": "Release agent",
  "variables": {
    "SERVICE": "checkout",
    "RETRIES": 2,
    "DRY_RUN": false
  },
  "workspace": "/path/to/checkout",
  "model": "<available-model-id>"
}
```

- `blueprint` is required and matches the latest blueprint name case-insensitively. Names must be unique.
- `variables` defaults to `{}` and accepts only string, finite number, or boolean values declared by the blueprint.
- `workspace` is optional. When present, it overrides the blueprint workspace selector and must remain inside `FORGEDECK_ROOTS`.
- `model` is optional. It overrides the blueprint model while retaining its backend and approval policy.

Every request must include:

- `Content-Type: application/json`
- `Idempotency-Key: <stable-delivery-id>`
- `X-ForgeDeck-Signature: sha256=<hex HMAC>`

The signature is the lowercase or uppercase hexadecimal HMAC-SHA256 digest of the exact raw HTTP body, using `FORGEDECK_WEBHOOK_SECRET` as the key. Do not parse and reserialize the JSON between signing and sending it. `X-Hub-Signature-256` is accepted as a signature-header alias, and `X-GitHub-Delivery` is accepted when `Idempotency-Key` is absent.

This Node.js example signs and sends one trigger:

```js
import { createHmac, randomUUID } from "node:crypto";

const body = JSON.stringify({
  blueprint: "Release agent",
  variables: { SERVICE: "checkout" },
  workspace: "/path/to/checkout"
});
const signature = createHmac("sha256", process.env.FORGEDECK_WEBHOOK_SECRET)
  .update(body)
  .digest("hex");

const response = await fetch("http://127.0.0.1:4173/api/webhook/trigger", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": randomUUID(),
    "x-forgedeck-signature": `sha256=${signature}`
  },
  body
});
console.log(response.status, await response.json());
```

A newly accepted operation returns HTTP `202`:

```json
{
  "status": "queued",
  "operationId": "123e4567-e89b-42d3-a456-426614174000",
  "operationUrl": "http://127.0.0.1:4173/api/operations/123e4567-e89b-42d3-a456-426614174000",
  "sessionUrl": null,
  "error": null
}
```

Repeat the same signed payload with the same idempotency key to read its current trigger state without creating another run. The response changes to `running` after creation begins or succeeds, and includes a dashboard `sessionUrl` once ForgeDeck knows the thread ID. A terminal create failure returns `status: "error"` with its operation error. Reusing a key with different validated input returns `409 IDEMPOTENCY_KEY_REUSED`.

Keep the webhook secret separate from the dashboard password, rotate it if exposed, and use HTTPS whenever callers connect across a network. Signatures authenticate requests but do not encrypt payloads.
