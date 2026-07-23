# ForgeDeck HTTP API

ForgeDeck's browser API is JSON over HTTP. Browser sessions use the `forgedeck_session` HttpOnly, SameSite=Strict cookie. Local MCP processes use a bearer actor credential minted from the private bootstrap token. Unless noted otherwise, routes require one of those credentials.

Runtime contracts live in `src/shared/contracts.ts` and are reused by Express, the browser client, SSE parsing, MCP tools, and contract tests. External timestamps are ISO 8601 UTC strings. Session/model fields use `provider`, `model`, `reasoningEffort`, and `sessionClass`; the previous `backend`, `effort`, and `class` request aliases remain temporarily accepted during migration.

Errors use this shape:

```json
{ "error": "Human-readable message", "code": "STABLE_CODE", "requestId": "..." }
```

The global API rate limit returns `429`, `Retry-After`, and `RateLimit-*` headers. Browser `Origin` values must exactly match the configured canonical public origin or an explicit trusted origin; matching only the request's `Host` header is not sufficient.

## Status and authentication

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth` | Return `{ authenticated }`; no prior login required |
| `POST` | `/api/webhook/trigger` | Spawn a blueprint session using an HMAC-signed payload; no dashboard cookie is required |
| `POST` | `/api/login` | Exchange `{ token }` for an expiring browser session cookie; session and attempt caps may return `429` |
| `POST` | `/api/logout` | Revoke the current browser token and immediately close all SSE streams opened by it |
| `GET` | `/api/health` | Minimal subsystem health; no prior login required |
| `GET` | `/api/bootstrap` | Stable, ETag-revalidated startup configuration: server identity/version, health summary, models, and workspaces |
| `GET` | `/api/account/status` | Short-lived account, usage, provider availability, and active-session status; supports `ETag` / `If-None-Match` |
| `GET` | `/api/approvals` | Current pending approvals and user questions |
| `GET` | `/api/queues?threadIds=...` | Queues for up to 100 requested sessions |
| `GET` | `/api/threads/:threadId/recovery` | Bounded live recovery state, queue, activity, and event revision for one session |
| `GET` | `/api/events/revision` | Current event revision without retrieving recovery output |
| `GET` | `/api/diagnostics/performance` | Aggregate API timings, Codex bridge metrics, turn capacity, and operation-pool saturation |
| `GET` | `/api/usage` | Persisted normalized usage events; optionally accepts `runId`, or `scopeType` plus `scopeId` for an aggregate |
| `GET` | `/api/budgets` | List run, blueprint, or workspace soft/hard budget policies |
| `PUT` | `/api/budgets` | Upsert `{ scopeType, scopeId, softLimit, hardLimit, exhaustionPolicy }` |
| `DELETE` | `/api/budgets?scopeType=...&scopeId=...` | Remove one budget policy |

The performance response contains only route templates/counts/timings, never query values or bodies. Its `operations.reads` and `operations.mutations` objects expose configured/effective concurrency, active and queued counts, queue wait and execution latency, saturation, recent error rate, and adaptive reduction/recovery counters. `capacity` reports per-provider active turns, waiters, cancellations, and capacity wait times. A degraded bootstrap or account-status response may return partial data with `degraded: true` and normalized errors rather than failing the whole page. Queue and recovery reads require an explicit, comma-separated `threadIds` projection; clients should batch only active, selected, or visible sessions.

## Workspaces and sessions

| Method | Route | Input / result |
| --- | --- | --- |
| `GET` | `/api/directories?path=...` | List allowed child directories with active lease status |
| `GET` | `/api/files?cwd=...&q=...` | Search up to 30 allowed workspace paths |
| `GET` | `/api/workspaces/:root/leases` | List active, overlapping read-only or exclusive leases for a URL-encoded workspace root |
| `GET` | `/api/threads` | Paginated list; accepts `cursor`, `limit`, `sortKey`, `sortDirection`, `search`, `provider`, and `sessionClass` |
| `GET` | `/api/archive` | List archived sessions with archive reason/time, TTL policy, retention countdown, pin exemption, and restore capability |
| `POST` | `/api/threads` | Durably accept creation from `{ cwd, provider, preset?, model?, reasoningEffort?, sessionClass?, leaseMode?, yolo?, permissionMode?, maxTurns?, name?, prompt?, tags?, category?, blueprintId?, blueprintVersion?, blueprintEnvironment?, blueprintVariables?, admissionPolicy?, projection?, guardian? }`; returns an operation (`202`) |
| `GET` | `/api/operations/:operationId` | Read durable create/archive progress, compensation state, and terminal result |
| `GET` | `/api/threads/:threadId` | Read one complete session |
| `GET` | `/api/sessions/:threadId/artifacts` | List typed artifacts plus validated/met/unmet completion gates |
| `POST` | `/api/sessions/:threadId/artifacts` | Validate and publish a typed artifact (`FileArtifact`, `PatchArtifact`, `TestResultArtifact`, `CommandArtifact`, or `ReviewVerdictArtifact`) |
| `GET` | `/api/artifacts/:artifactId` | Read one versioned artifact envelope by ID |
| `GET` | `/api/sessions/:threadId/export?format=json\|markdown` | Download a privacy-safe structured run record with provenance, prompts, key outputs, and artifact summaries |
| `PATCH` | `/api/threads/:threadId` | Update `name`, `tags`, `category`, and/or guardian policy |
| `GET` | `/api/sessions/:threadId/guardian` | Read durable stall/recovery state and policy |
| `POST` | `/api/sessions/:threadId/guardian/retry` | Interrupt the stalled turn and resubmit its last recorded message |
| `POST` | `/api/sessions/:threadId/guardian/escalate` | Retry on a stronger model; accepts optional `{ model }` |
| `POST` | `/api/sessions/:threadId/restore` | Unarchive a provider-supported session and return it to the active inventory |
| `POST` | `/api/sessions/:threadId/pin` | Set `{ pinned }` (or omit it to toggle); pinned sessions are exempt from automatic TTL cleanup |
| `POST` | `/api/sessions/:threadId/lease` | Acquire `{ mode: "read-only" | "exclusive" }`, or release an idle session's lease with `{ mode: null }` |
| `DELETE` | `/api/threads/:threadId` | Accept an asynchronous archive job (`202`) |
| `GET` | `/api/threads/:threadId/history` | Read bounded ForgeDeck audit history |
| `POST` | `/api/threads/batch` | `read`, `archive`, or `organize` up to the documented server limit |
| `POST` | `/api/threads/:threadId/messages` | Start `{ text, model, reasoningEffort?, admissionPolicy?, projection? }` immediately (`202`) |
| `POST` | `/api/threads/:threadId/queue` | Persist a message to run after the active turn (`202`) |
| `DELETE` | `/api/threads/:threadId/queue/:queueId` | Remove a queued message |
| `POST` | `/api/threads/:threadId/interrupt` | Interrupt `turnId`, or the detected active turn |
| `PATCH` | `/api/threads/:threadId/policy` | Set `{ yolo: boolean }` while idle |
| `POST` | `/api/threads/:threadId/command` | Run ForgeDeck commands such as `compact`, `stop`, `rename`, `archive`, or `goal` |
| `POST` | `/api/approvals/:requestId` | Resolve a pending Codex approval or user question |

Thread IDs, model choices, reasoning levels, request keys, strings, tags, batch sizes, and JSON body size are validated and bounded at the API boundary. MCP actors can read all sessions but can mutate only sessions they created. Create and destructive requests accept `Idempotency-Key`; reuse with the same validated input returns the original operation, while reuse with different input returns `409 IDEMPOTENCY_KEY_REUSED`.

`preset` is one of `quick`, `balanced`, or `deep`. These are transparent fixed mappings: Quick is `gpt-5.6-luna` with `low` effort, Balanced is `gpt-5.6-sol` with `medium` effort, and Deep is `gpt-5.6-sol` with `xhigh` effort. Supplying conflicting manual model or effort fields is rejected; no dynamic routing occurs.

Workspace leases are acquired before provider work starts and released after terminal completion, confirmed failure/interruption, or archival. Multiple `read-only` leases may overlap; an `exclusive` lease conflicts with every other session whose workspace is the same path, a parent, or a child. Conflicts return `409 WORKSPACE_LEASE_CONFLICT`. Active leases are intentionally process-local so an unclean process exit cannot leave a permanent stale holder; running sessions are reconciled when the provider reconnects.

Create and archive operations expose `status`, `currentStep`, `remoteThreadId`, `attemptCount`, `compensation`, `result`, `error`, timestamps, and a `links.self` polling URL. Incomplete operations resume after startup. A remote timeout is treated as indeterminate: ForgeDeck discovers remote state before retrying, and a failed create remains in compensation until any known or discovered remote thread is archived.

Guardian policy is `{ stallTimeoutMinutes, escalationModel? }` and can be set at session creation, by session patch, or in a blueprint definition. The default timeout is 10 minutes. A stalled run resubmits its last message twice, uses a configured or available stronger model for its third recovery attempt, then emits an operator incident and pauses if that attempt also stalls. Guardian state and counters are persisted, so provider runs rediscovered after a server restart resume supervision without resetting their retry budget. Recovery never changes the session's permission policy.

Archive is distinct from permanent deletion: ForgeDeck has no permanent-delete endpoint. Accepting an archive durably records the request before clearing queued messages or interrupting a turn. Remote archival and local cleanup are retried from their persisted steps; a definitive rejection restores saved queued work and active visibility. Archive metadata is retained for `FORGEDECK_METADATA_RETENTION_HOURS`; the archive response exposes that cleanup deadline, while pinned sessions have no automatic deadline. Codex sessions can be restored through the provider's unarchive operation; providers without that capability are reported as non-restorable.

## Knowledge packs

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/knowledge-packs?workspace=...&scope=...` | List packs and cached preview content; a workspace filter includes global packs plus packs for that workspace |
| `POST` | `/api/knowledge-packs` | Create and cache `{ name, scope, workspace?, sources }` |
| `DELETE` | `/api/knowledge-packs?id=...` | Remove one pack; `DELETE /api/knowledge-packs/:id` is also supported |
| `POST` | `/api/knowledge-packs/:id/refresh` | Explicitly invalidate and rebuild one cached pack |

Each source is `{ "type": "file" | "path" | "url", "reference": "..." }`. A `path` may name a file or directory. Relative workspace sources resolve inside that workspace and cannot escape it; global filesystem sources must be absolute. Rendered content, source metadata, errors, and a SHA-256 content hash are stored in SQLite. Filesystem metadata is checked before every preview or injection and changed sources are rebuilt automatically; URL content changes only on explicit refresh.

When a session is durably accepted, ForgeDeck records the IDs of all global packs and packs matching its validated workspace. Their current cached content is prepended to the first accepted message only, including when that message was queued or sent after an ownership handoff. Sessions that start with no matching packs are unaffected, and packs created later are not retroactively attached.

## Agent blueprints

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/blueprints?search=...&limit=...` | Search the latest local version of each blueprint |
| `POST` | `/api/blueprints` | Validate and create version 1 from `{ name, description?, definition }` |
| `GET` | `/api/blueprints/:blueprintId?version=...` | Read the latest or an exact immutable version |
| `GET` | `/api/blueprints/:blueprintId/versions` | List all immutable versions |
| `POST` | `/api/blueprints/:blueprintId/versions` | Append a validated immutable version |
| `GET` | `/api/blueprints/:blueprintId/export?version=...` | Export one portable manifest as JSON |
| `POST` | `/api/blueprints/import` | Validate and import a portable manifest without changing its ID or version |

A blueprint definition contains its prompt template, role, workspace selector, model/routing policy (including an optional fixed preset), enabled and disabled tools, file/URL knowledge references, completion gates, approval requirements, optional guardian policy, and typed input-variable schema. A completion gate keeps the session in a gated/waiting state until required evidence exists. In addition to `name`, `description`, and `required`, gates can select `artifactType`, `artifactName`, a named `path`, a JSON `schema`, `minimumCount`, `mustPass`, and a provenance `trust` level (`deterministic`, `human`, or `advisory`). Older descriptive gates remain valid and infer common test, patch, file, command, and review evidence from their names.

Artifact envelopes contain their type, artifact schema and version, producer session/turn/item, provenance and trust, SHA-256 content hash, retention policy, validation result, and creation/update timestamps. Completed command, test, file-change, and patch items are captured automatically. Large or sensitive bodies are placed in permission-restricted content-addressed storage and returned by reference while their non-sensitive typed status stays inline. Invalid patches, contradictory command/test results, invalid structured data, failed tests, and non-approved review verdicts cannot satisfy a required gate. Secret variables cannot have defaults or request-supplied values; manifests retain only references such as `${API_KEY}`. Sessions launched from a blueprint resolve an exact version and persist that version together with the named environment and effective model configuration.

External services can launch the latest version of a uniquely named blueprint through `POST /api/webhook/trigger`. This route uses its own HMAC authentication and does not accept or require dashboard credentials. See [signed webhook triggers](WEBHOOKS.md) for the payload, signing, idempotency, and response format.

## Scheduled blueprint runs

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/schedules?historyLimit=...` | List durable schedules with their last/next run timestamps and recent run history |
| `POST` | `/api/schedules` | Create a schedule from `{ name?, blueprintId, blueprintVersion?, variables?, workspace?, timing }` |
| `PUT` | `/api/schedules/:scheduleId` | Replace a schedule configuration while retaining its existing history |
| `DELETE` | `/api/schedules/:scheduleId` | Delete a schedule and its run history |

`timing` is one of `{ "type": "once", "runAt": "...ISO timestamp..." }`, `{ "type": "interval", "intervalMs": 3600000 }`, or `{ "type": "cron", "expression": "0 9 * * 1-5" }`. Cron expressions use the server's local timezone and the standard five fields (minute, hour, day of month, month, weekday). The scheduler checks every minute. It pins the selected immutable blueprint version, persists each due run before spawning the session, and resumes interrupted pending runs through the existing idempotent session-operation path.

## Mission graphs

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/missions` | List the latest immutable mission versions with their latest durable run and node progress |
| `POST` | `/api/missions` | Create a mission, or append a version when the supplied `id` already exists |
| `GET` | `/api/missions/:missionId?version=...` | Read the latest or an exact immutable mission version |
| `DELETE` | `/api/missions/:missionId` | Delete a mission and its completed run history; `DELETE /api/missions?id=...` is also supported |
| `POST` | `/api/missions/:missionId/run` | Start the latest version with `{ inputs?, workspace? }` |

A mission is a validated DAG of one to 50 nodes. Each node pins a `blueprintId` and `blueprintVersion`, declares `dependsOn`, and provides `inputMapping` and `outputMapping` objects. Input values come from `{ "source": "mission", "key": "..." }`, an ancestor node via `{ "source": "node", "nodeId": "...", "key": "..." }`, or a primitive literal. Output mappings name paths from the completed node envelope, whose foundation fields are `text`, `threadId`, and `artifacts`.

Runs are persisted in SQLite with `pending`, `running`, `completed`, `failed`, or `paused` mission state and per-node progress. The runner starts at most one node at a time, waits for its agent turn and completion gates to finish, then selects the next dependency-ready node in definition order. Session creation is idempotent per mission run and node, so unfinished work resumes after process startup without launching a duplicate node.

## Model comparisons

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/compare` | Run one prompt across two to eight model/effort branches, with an optional judge |
| `GET` | `/api/compare?limit=...` | List persisted comparison runs and their current results |
| `GET` | `/api/compare/:comparisonId` | Read one comparison, including outputs, pairwise diffs, and judge scores |

The request is `{ prompt, workspace, models, judge? }`, where each model is `{ provider, model, reasoningEffort }`. Candidate branches start concurrently, share the validated workspace through read-only leases, and queue behind the existing provider capacity limits. Results persist each branch's output, session and operation IDs, status, timing, and normalized token usage. ForgeDeck stores a bounded line diff for every output pair.

When `judge` is set, that model runs only after the candidate branches finish. It receives the original prompt and delimited, untrusted candidate outputs, then must return a validated 0–100 score and rationale for every output plus an optional winner. A judge failure does not discard completed candidate outputs or diffs.

## Eval lab

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/evals` | Create and asynchronously run a versioned eval across one or more models |
| `GET` | `/api/evals?limit=...` | List persisted eval versions and their current result summaries |
| `GET` | `/api/evals/:evalId?version=...` | Read the latest or an exact eval version with per-model results |

An eval request contains `name`, `blueprintId`, optional `blueprintVersion`, blueprint `variables`, a validated `workspace`, a `models` array of `{ provider, model, reasoningEffort }`, and `successCriteria`. Criteria support required and forbidden output phrases, optional duration and total-token ceilings, and the blueprint's deterministic completion gates. Every model receives the same rendered prompt snapshot under a shared read-only workspace lease. Results record the session and operation IDs, output, pass/fail score with scorer version, timing, and normalized input/output/total token usage. Supplying a prior `evalId` creates the next immutable version.

Budget limits use any subset of `requestCount`, `totalTokens`, and `estimatedCostMicros`; cost budgets require `FORGEDECK_COST_CATALOG_JSON`. A soft limit admits the request and emits an alert. A hard limit applies its `wait`, `pause`, `downgrade`, or `fallback` policy before turn capacity is acquired. `projection` accepts the same metrics for preflight accounting. Switch policies must be declared on the request as, for example, `{ "action": "downgrade", "approved": true, "target": { "provider": "codex", "model": "model-id" } }`; provider/model changes are never inferred. Cross-provider fallback for an existing session returns `ADMISSION_SWITCH_REQUIRED` because the target needs a separately created run.

`/api/usage` returns raw token/request facts and optional aggregate estimates. Estimate rows are derived from the configured catalog version and are not merged with provider quota percentages. This preserves later re-estimation and prevents subscription utilization from being presented as exact spend.

## Server-sent events

`GET /events` opens an authenticated `text/event-stream`. Event names are:

- `connected`: initial connection timestamp and current stream revision.
- `session-ended`: terminal `logout` or `expired` notice; the server closes the stream immediately afterward.
- `runtime`: Codex runtime state changes.
- `threads`: session creation, update, and removal hints.
- `codex`: normalized Codex notifications and streaming deltas.
- `approval` / `approval-resolved`: pending interactive requests.
- `queue`: the authoritative queue for one thread.
- `admission`: soft/hard budget alerts, wait/pause decisions, and budget policy changes.
- `guardian`: durable stall, retry, model-escalation, failure, and operator-pause state.

Every data-bearing message has a monotonic SSE `id` and a runtime-validated JSON envelope: `{ eventId, schemaVersion, threadId, payload }`. The SSE frame `id` must match `eventId`, `schemaVersion` is currently `1`, and timestamp-bearing payload fields use ISO 8601. `GET /api/threads/:threadId/recovery` returns that thread's bounded live overlay, queue, active flag, and authoritative stream revision; `GET /api/events/revision` supplies the recovery boundary when no thread is visible. Clients recover snapshots after reconnect or an observed sequence gap, apply item/token/delta events locally, and reserve full thread-detail reads for explicit refreshes and terminal reconciliation.

Each stream is bound to the exact authenticated browser session that opened it. Logout and absolute token expiry close every stream for that session. Clients must tolerate malformed or unknown events and recover authoritative state after reconnecting. ForgeDeck bounds individual events and retained output; slow clients are disconnected so the browser's `EventSource` can reconnect instead of growing server memory without limit.

## MCP bootstrap

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/mcp/actors` | With the bootstrap bearer token, create or recover the stable actor for `{ clientId }` and rotate its credential |
| `POST` | `/api/mcp/actors/current/rotate` | With the current actor credential, rotate the credential without changing the actor ID |
| `DELETE` | `/api/mcp/actors/current` | Revoke the actor and release ownership; requires `{ releaseOwnership: true }` |
| `GET` | `/api/mcp/owned-threads` | List the authenticated actor ID and owned session IDs |
| `POST` | `/api/mcp/handoffs` | Create a short-lived, one-time token that lets another actor hand sessions to this actor |
| `POST` | `/api/mcp/owned-threads/handoff` | Atomically transfer owned `threadIds` to the actor named by a handoff token |

The bootstrap token is stored at `.data/mcp-token`. The stdio client persists its scoped bearer credential under `.data/mcp-actors/`; bootstrap and actor tokens must never be sent to the browser or logged. Expired or inactive credentials can be recovered without changing actor identity or ownership. See [MCP identity and threat model](MCP_IDENTITY.md).
