# ForgeDeck HTTP API

ForgeDeck's browser API is JSON over HTTP. Browser sessions use the `forgedeck_session` HttpOnly, SameSite=Strict cookie. Local MCP processes use a bearer actor credential minted from the private bootstrap token. Unless noted otherwise, routes require one of those credentials.

Errors use this shape:

```json
{ "error": "Human-readable message", "code": "STABLE_CODE", "requestId": "..." }
```

The global API rate limit returns `429`, `Retry-After`, and `RateLimit-*` headers. Cross-origin browser calls are rejected unless their exact HTTP(S) origin is configured.

## Status and authentication

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth` | Return `{ authenticated }`; no prior login required |
| `POST` | `/api/login` | Exchange `{ token }` for a browser session cookie |
| `POST` | `/api/logout` | Revoke the current browser session |
| `GET` | `/api/health` | Minimal subsystem health; no prior login required |
| `GET` | `/api/bootstrap` | Models, account summary, usage, workspaces, queues, live state, and degradation flags |
| `GET` | `/api/diagnostics/performance` | Aggregate API timings and Codex bridge metrics |

The performance response contains only route templates/counts/timings, never query values or bodies. A degraded bootstrap may return partial data with `degraded: true` and normalized errors rather than failing the whole page.

## Workspaces and sessions

| Method | Route | Input / result |
| --- | --- | --- |
| `GET` | `/api/directories?path=...` | List allowed child directories |
| `GET` | `/api/files?cwd=...&q=...` | Search up to 30 allowed workspace paths |
| `GET` | `/api/threads` | Paginated list; accepts `cursor`, `limit`, `sortKey`, `sortDirection`, and `search` |
| `POST` | `/api/threads` | Create from `{ cwd, model, effort?, yolo?, name?, prompt?, tags?, category? }` |
| `GET` | `/api/threads/:threadId` | Read one complete session |
| `PATCH` | `/api/threads/:threadId` | Update `name`, `tags`, and/or `category` |
| `DELETE` | `/api/threads/:threadId` | Accept an asynchronous archive job (`202`) |
| `GET` | `/api/threads/:threadId/history` | Read bounded ForgeDeck audit history |
| `POST` | `/api/threads/batch` | `read`, `archive`, or `organize` up to the documented server limit |
| `POST` | `/api/threads/:threadId/messages` | Start `{ text, model, effort? }` immediately (`202`) |
| `POST` | `/api/threads/:threadId/queue` | Persist a message to run after the active turn (`202`) |
| `DELETE` | `/api/threads/:threadId/queue/:queueId` | Remove a queued message |
| `POST` | `/api/threads/:threadId/interrupt` | Interrupt `turnId`, or the detected active turn |
| `PATCH` | `/api/threads/:threadId/policy` | Set `{ yolo: boolean }` while idle |
| `POST` | `/api/threads/:threadId/command` | Run ForgeDeck commands such as `compact`, `stop`, `rename`, `archive`, or `goal` |
| `POST` | `/api/approvals/:requestId` | Resolve a pending Codex approval or user question |

Thread IDs, model choices, reasoning levels, request keys, strings, tags, batch sizes, and JSON body size are validated and bounded at the API boundary. MCP actors can read all sessions but can mutate only sessions they created.

## Server-sent events

`GET /events` opens an authenticated `text/event-stream`. Event names are:

- `connected`: initial connection timestamp.
- `runtime`: Codex runtime state changes.
- `threads`: session creation, update, and removal hints.
- `codex`: normalized Codex notifications and streaming deltas.
- `approval` / `approval-resolved`: pending interactive requests.
- `queue`: the authoritative queue for one thread.

Clients must tolerate malformed or unknown events and refresh authoritative state after reconnecting. ForgeDeck bounds individual events and retained output; slow clients are disconnected so the browser's `EventSource` can reconnect instead of growing server memory without limit.

## MCP bootstrap

`POST /api/mcp/actors` requires the bootstrap bearer token from `.data/mcp-token` and returns an isolated actor credential. `GET /api/mcp/owned-threads` lists that actor's owned session IDs. Bootstrap and actor tokens must never be sent to the browser or logged.
