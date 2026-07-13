# Code Quality Audit Report

## Summary

ForgeDeck is a capable local-first application with a solid functional core, sensible security defaults, strict TypeScript configurations, and several well-isolated server utilities. The project currently passes both TypeScript checks, builds successfully, and passes all 12 tests. There are no circular dependencies in the requested source set, no uses of explicit `any`, no `@ts-ignore`/`@ts-expect-error`, and no TODO/FIXME/HACK markers.

The overall code quality is **moderate**: good for a focused early-stage application, but carrying substantial maintainability and reliability risk as it grows. The two primary entry files are monoliths: `src/server/index.ts` is 831 lines and combines startup, routing, persistence, process lifecycle, streaming, queueing, authorization policy, and event reduction; `src/client/App.tsx` is 1,165 lines and combines nearly the entire UI, data access, event processing, state persistence, and rendering. These concentrations make otherwise reasonable logic difficult to test and change safely.

The highest-priority correctness issues are:

1. Several client-side async callbacks can reject without a catch, including session creation completion, rename/archive, logout, and some event-triggered refreshes. These are real uncaught-promise paths.
2. JSON from SSE, HTTP responses, local storage, and persisted server files is mostly trusted through casts rather than validated at runtime. Corrupt or incompatible data can crash the UI or poison queues/state.
3. Upstream Codex errors are generally collapsed to HTTP 500, even when they represent conflicts, missing resources, or invalid requests. API 404s also fall through to Express's HTML response.
4. Session creation performs irreversible work before naming, policy persistence, ownership assignment, and initial-turn startup are known to have succeeded. A late failure can return an error even though a partially configured thread exists.
5. Test coverage is concentrated in utility modules. The Express API, Codex bridge, MCP tool server, queue/event orchestration, and React client have no tests.

Audit verification performed on 2026-07-13:

- Read all 15 requested `.ts`, `.tsx`, and `.mjs` files under `src/` and `scripts/` in full (3,747 lines), all four test files, and every named configuration/documentation file.
- `npm run check`: passed.
- `npm run build`: passed; the main client bundle was 373.25 kB (115.49 kB gzip), with a 1.83 MB source map.
- `npm test`: 12/12 tests passed.
- Node's experimental coverage run reported 57.27% line coverage over files loaded by the tests. This is not whole-project coverage; major untested modules were absent from the report.
- The worktree remained clean after verification.

## Architecture

### Strengths

- Server concerns that have already been extracted are cohesive. `AuthManager`, `McpAccessManager`, `WorkspacePaths`, `CodexBridge`, and `ExternalCodexMonitor` each have a recognizable responsibility and mostly narrow public APIs.
- The dependency graph is simple and acyclic. `src/server/index.ts` depends on leaf server modules; tests depend on their target modules; `src/client/main.tsx` depends on `App.tsx`, which depends on `types.ts`. No source module imports back toward an entrypoint.
- MCP ownership checks are centralized in `McpAccessManager` and enforced before mutation routes. Workspace canonicalization uses `realpath`, containment checks, and sensitive-directory blocking rather than relying on string prefixes.
- Durable JSON writes use a temporary file followed by rename, reducing the chance of a partially written primary state file.
- The Codex transport is separated from HTTP concerns and supports both a child process and the durable WebSocket runtime.

### Findings

- **High — The Express application is not cleanly layered.** `src/server/index.ts:13-499` performs top-level dependency construction, all middleware and route registration, event wiring, external-monitor startup, server startup, and shutdown handling. The remainder implements queueing, persistence, validation, event reduction, and utilities. There is no app factory, router split, handler/service boundary, or dependency injection point. Importing the module starts external processes and a listening server, which prevents focused API tests.
- **High — The React client is effectively one application module.** `src/client/App.tsx` contains the application store, HTTP client, SSE reducer, local-storage persistence, every major screen/modal/card, renderers, composer behavior, and formatting helpers. The root `App` component alone spans approximately 460 lines (`34-494`) and owns more than 20 state values. `ControlCenter`, `ControlCard`, `Chat`, and approval/session creation flows should be independent feature modules.
- **Medium — Global mutable server state obscures ownership and invariants.** Message queues, policies, live items, active-source sets, active turn IDs, capacity buffers, and SSE clients are module globals. Their transitions are spread between routes, Codex events, external-monitor events, timers, and shutdown logic. A dedicated session/queue coordinator would make state transitions explicit and testable.
- **High — Thread creation is not transaction-like.** In `src/server/index.ts:175-205`, `thread/start` succeeds before MCP ownership, policy persistence, naming, broadcasting, and optional `turn/start`. If naming or initial turn startup fails, the request returns an error although the thread already exists. Retrying may create duplicates. The API should return the created thread with a partial-start warning, or compensate/roll back when safe.
- **High — Failed starts can leave monitoring ownership stuck.** `bridgeOwnedThreads.add(threadId)` occurs before `thread/resume`/`turn/start` in the message route (`src/server/index.ts:224-234`) and queue drain (`529-532`). On failure, the ID is not removed. The external monitor then ignores that thread at `src/server/index.ts:468`, potentially indefinitely.
- **Medium — The external monitor does synchronous, platform-specific work on the event loop.** Every 650 ms it performs synchronous SQLite queries, scans `/proc`, reads descriptor metadata, and reads rollout files (`src/server/external-monitor.ts:45-104`, `235-272`). This can delay API/SSE work on a busy host. The monitor also keeps trackers and call maps indefinitely; `recent` is bounded, but `trackers` and `calls` are not pruned.
- **Medium — Startup is tightly coupled to all integrations.** Top-level construction of workspace roots, Codex, and `ExternalCodexMonitor` means an unavailable workspace root, missing/incompatible Codex state database, or failed runtime initialization prevents the web server from becoming available for a useful diagnostic response.
- **Medium — API contracts are duplicated rather than shared.** The client types model server payloads separately, while server/MCP code uses broad records. For example, the client treats the create response as a full `Thread` at `src/client/App.tsx:993`, while the server only types the Codex response as `{ thread: { id: string } }` at `src/server/index.ts:182`. A shared protocol package plus runtime schemas would prevent drift.
- **Low — The MCP module is also over-concentrated.** `src/server/mcp.ts:22-208` registers every tool inside one large `main` function, followed by its client and serialization utilities. Tool definitions can be grouped by read/mutation/session concerns and tested independently.

## TypeScript Quality

### Strengths

- Both client and server use `strict: true`, and both strict checks pass.
- There is no explicit `any` in the audited source, and there are no TypeScript suppression comments.
- Public utility methods generally have clear return types. Domain-specific types exist for threads, turns, queues, goals, paths, RPC messages, actor storage, and live state.
- Error-catching sites normally begin with `unknown` and narrow using `instanceof Error` before reading messages.

### Findings

- **High — Runtime data is frequently converted into trusted types with assertions.** Examples include RPC JSON (`src/server/codex-bridge.ts:159`), persisted MCP access (`src/server/mcp-access.ts:97`), queue/policy files (`src/server/index.ts:561,579`), HTTP payloads (`src/client/App.tsx:1067`, `src/server/mcp.ts:237`), SSE events (`src/client/App.tsx:186-245`), and local storage (`src/client/App.tsx:42-46,95,387`). Strict TypeScript cannot protect these boundaries without runtime parsing.
- **Medium — Core client protocol types are too permissive.** `ThreadItem` has `type: string`, many optional fields, and a catch-all `[key: string]: unknown`. This makes invalid field combinations legal and forces rendering code to inspect/cast dynamically. A discriminated union for user messages, agent messages, commands, file changes, plans, and tool calls would significantly improve exhaustiveness and signatures.
- **Medium — EventEmitter payloads are untyped.** `CodexBridge` extends the untyped Node `EventEmitter`, so consumers cast notification payloads in `src/server/index.ts:425-426`. A typed event map or explicit subscription interface would remove casts and document lifecycle events.
- **Medium — Request bodies are validated ad hoc from Express's permissive `req.body`.** Helper functions cover required strings, but route body shapes are not represented as types or schemas. This permits silent coercion/omission: for example, any policy payload other than `{ yolo: true }` disables YOLO, and non-string optional values become `null` rather than a 400 response.
- **Medium — Non-null assertions hide assumptions.** Examples include the root DOM node (`src/client/main.tsx:6`), default/selected models (`src/client/App.tsx:764,974-975,1014`), goal presence (`821`), browser path (`1010`), authentication session ID (`src/server/index.ts:62`), and several live-state branches. Most are locally plausible, but empty model lists or incompatible bootstrap data can turn them into crashes.
- **Medium — The generic `api<T>` helpers assert rather than establish `T`.** Both browser and MCP clients return parsed values as the requested generic type without validation. Call sites can request an inaccurate shape with no compiler feedback from the server implementation.
- **Low — An unused import is present.** `MoreHorizontal` is imported in `src/client/App.tsx:6` but never used. The compiler does not report it because `noUnusedLocals`/`noUnusedParameters` are not enabled, and there is no lint script.
- **Low — A React-hooks lint suppression exists without a configured linter.** `src/client/App.tsx:604-606` documents an intentional dependency choice, but the project has no ESLint dependency or lint command, so other hook dependency mistakes are not checked.
- **Low — JavaScript service scripts are outside TypeScript checking.** The `.mjs` installers have no JSDoc types, linting, or automated tests. This is acceptable for small scripts but leaves the systemd generation path unchecked.
- **Low — Typed errors are inconsistent.** `PathError` and `ForgeDeckApiError` are classes, while HTTP errors are `Error & { status: number }` and Codex RPC metadata is attached with `Object.assign`. A common typed error model would simplify reliable status mapping.

## Error Handling

### Strengths

- Express async handlers consistently forward failures to the error middleware.
- Authentication, throttling, path validation, message-size validation, missing active turns, and approval validation use appropriate 4xx statuses in the paths explicitly handled by ForgeDeck.
- Background poll and queue loops have internal `try/catch/finally` protection, and the Codex bridge rejects outstanding calls if the runtime connection closes.
- Shutdown handles SIGINT/SIGTERM, closes SSE connections, stops the monitor/bridge, and includes a forced-exit timeout.

### Findings

- **High — The client has uncaught promise-rejection paths.** `onCreated` is async (`src/client/App.tsx:397-403`) but is typed as returning `void` and called without `await` at `994`; a failed `loadThreads` escapes the modal's catch. Async rename/archive callbacks (`460-469`) have no catch. Logout is invoked with `void` and has no catch (`405-409`, `451`). Runtime-ready refreshes (`189-190`) and the delayed list refresh (`281`) also omit `.catch`. Using `void` only discards the promise; it does not handle rejection.
- **High — Codex errors are not normalized to HTTP semantics.** `CodexBridge` attaches RPC `code`/`data` to a plain `Error` (`src/server/codex-bridge.ts:170-173`), but the Express error middleware looks only for `status` (`src/server/index.ts:458-462`). Expected conflicts, not-found conditions, and invalid state from Codex therefore become 500 responses. This also undermines the MCP client's intended 409 fallback at `src/server/mcp.ts:160-165`.
- **High — Corrupt local storage can crash the React application during initialization.** Multiple state initializers call `JSON.parse` without guards (`src/client/App.tsx:43-46,56`). Later completion metadata parsing is also unguarded (`95,387`). A stale or manually edited value can prevent the app from rendering.
- **High — SSE event payloads are parsed without protection or schema checks.** Every event listener assumes valid JSON and expected fields (`src/client/App.tsx:185-283`). A malformed or version-skewed notification throws from the event callback and can leave UI state inconsistent.
- **Medium — Persisted server JSON is only superficially validated.** Queue loading checks that values are non-empty arrays but not that entries contain valid text/model/effort fields (`src/server/index.ts:558-566`). MCP storage validates token hashes but not timestamps or the full structure. Invalid queue entries can repeatedly fail at drain time.
- **Medium — Queue failures are retained but not retried on a schedule.** `drainQueue` broadcasts/logs a failure and leaves the entry in place (`src/server/index.ts:538-546`), but no backoff retry is scheduled. It may remain stuck until a later event or process restart happens to call `drainQueue`.
- **Medium — Initial Codex transport failures can leave stale transport state.** `spawnChild` assigns `this.child` before spawn succeeds, and initialization failures do not tear down the child/socket (`src/server/codex-bridge.ts:43-83`). A later `start()` can see a non-killed child or open socket and return without successfully completing initialization.
- **Medium — There are no process-level `unhandledRejection` or `uncaughtException` diagnostics.** Global handlers are not a substitute for local catches, but given the floating client promises and top-level integration startup, explicit fatal logging/shutdown behavior would improve operational clarity. The MCP entrypoint also invokes top-level `main()` without contextual fatal-error reporting.
- **Medium — 500 responses expose internal error messages and mislabel every server fault.** `src/server/index.ts:462` returns `Codex runtime error: ${message}` for all 5xx errors, including filesystem/persistence/programming errors. This can expose paths or implementation detail and makes diagnosis less accurate.
- **Low — Unknown API paths return Express's default HTML 404.** There is no JSON API not-found middleware between route registration and the error handler. API consumers should receive a stable `{ error }` shape.
- **Low — Malformed cookie encoding can produce a 500.** `decodeURIComponent` in `src/server/auth.ts:133` is not guarded. A malformed cookie should be treated as absent.
- **Low — Some intentionally ignored errors are too broad.** Account/usage/bootstrap goal reads collapse all errors to fallback values, and file search ignores all directory-read failures. This keeps the UI alive but makes permission and compatibility problems difficult to distinguish from absence.
- **Low — The MCP actor registration promise is permanently poisoned after one failure.** `ForgeDeckApi.ensureActor` caches a rejected promise (`src/server/mcp.ts:240-250`), so the MCP process cannot recover if the dashboard is unavailable only during its first tool call.

### Input validation assessment

- Good: absolute/canonical workspace validation, root containment, sensitive directory rejection, thread ID format, model/effort account validation, message length, list limits, sort enums, approval decisions, and MCP tool inputs via Zod.
- Missing or weak: common route schemas, strict unknown-field/type handling, explicit create-prompt length, policy body validation, name behavior for non-strings, query string length, persisted-file validation, SSE/HTTP response validation, and a consistent representation of upstream Codex errors.

## Test Coverage

### Current suite

There are four test files containing 12 passing tests:

- `auth.test.ts` (3): configured password acceptance/rejection, generated token persistence/mode, and disabled authentication.
- `external-monitor.test.ts` (6): injected-context filtering, apply-patch detection, writable rollout discovery, no-procfs fallback, and reverse lifecycle recovery.
- `mcp-access.test.ts` (2): actor ownership isolation and persistence across manager restart.
- `paths.test.ts` (1): directory listing, credential-directory rejection, and configured-root escape rejection.

These are meaningful tests. They use temporary directories, restore environment state, exercise real filesystem behavior, and verify important security boundaries rather than merely snapshotting output.

### Measured coverage

Node's experimental test coverage reported:

| Production module loaded by tests | Line coverage | Function coverage | Main gap |
| --- | ---: | ---: | --- |
| `auth.js` | 56.69% | 45.45% | cookies, expiry/pruning, throttling, middleware |
| `external-monitor.js` | 24.48% | 36.36% | almost the entire monitor class/event parser |
| `mcp-access.js` | 92.74% | 88.24% | error/middleware and some listing paths |
| `paths.js` | 59.26% | 80.00% | file search, invalid paths, scoring and limits |

The report's 57.27% aggregate includes test files and only modules imported by those tests. It excludes `src/server/index.ts`, `codex-bridge.ts`, `mcp.ts`, all React code, and the scripts. Whole-project coverage is therefore materially lower and is not currently measured by the package scripts.

### Missing tests

- **Critical gap:** Express API integration tests for authentication middleware, origin protection, status codes, body validation, thread creation/message/queue/policy/archive routes, MCP ownership enforcement, approvals, JSON 404s, and error normalization.
- **Critical gap:** queue/event state-machine tests, including concurrent send-vs-completion races, retry behavior, restart recovery, partial creation failure, bridge/external source reconciliation, and cleanup of `bridgeOwnedThreads`.
- **Critical gap:** `CodexBridge` tests with fake child/socket transports for startup error, initialize timeout, malformed messages, RPC errors, pending timeout, server requests, disconnect, reconnect, and stop.
- **High gap:** React component/hook tests for login, bootstrap failure, corrupt local storage, SSE updates, send-vs-queue behavior, approvals, model changes, directory browsing, errors, and accessibility/keyboard behavior.
- **High gap:** external monitor integration tests for `processLine`, commands/tools/patches, malformed records, partial JSONL lines, completion reconciliation, and tracker pruning. Current coverage mostly tests exported helpers.
- **High gap:** MCP server/API client tests for actor retry, pagination, ownership errors, timeout/error payloads, summarization, and each tool's Zod contract.
- **Medium gap:** path search traversal/depth/scan/limit behavior, symlinks, unreadable directories, non-directory roots, and hidden file handling.
- **Medium gap:** auth throttling and reset, rolling session expiry, logout/cookies, malformed cookies, short configured passwords, and pruning.
- **Medium gap:** service installer unit rendering, path escaping, missing client bundle, `CODEX_BIN` overrides, and partial systemctl failure.

The `npm test` script runs `build/server/**/*.test.js` but does not build first. On a clean checkout it fails if `build/` does not exist; after source changes it can run stale compiled tests. Use a pretest build step or run tests directly from TypeScript.

## Code Smells

### Comments and suppressions

- No TODO, FIXME, HACK, or XXX comments were found.
- No `@ts-ignore` or `@ts-expect-error` was found.
- There is one ESLint suppression for a hook dependency (`src/client/App.tsx:604-606`), but no linter is configured.

### Long or over-responsible code

- `src/server/index.ts` is an 831-line composition root with roughly 500 lines of top-level setup/routes/events before helper functions.
- `App` spans `src/client/App.tsx:34-494` and handles authentication, bootstrap, list/detail loading, SSE, local persistence, selection, control-center state, and shell rendering.
- `ExternalCodexMonitor.processLine` (`114-214`) is a 100-line protocol decoder with many record variants and state mutations.
- MCP `main` (`src/server/mcp.ts:22-208`) is about 185 lines of inline tool registration.
- Many JSX components are compressed into extremely long single return lines. This reduces diff readability and makes accessibility/behavior review harder even when line count appears small.

### Duplicated logic

- `ControlCard` and `Chat` duplicate message submission, slash-command handling, running-state calculation, history/live reconciliation, model selection, and queue-vs-send decisions.
- `CompactItem` and `ItemView` duplicate rendering logic for messages, reasoning, commands, file changes, plans, and dynamic tools.
- Archive cleanup is duplicated between `/command` and `DELETE /api/threads/:threadId` (`src/server/index.ts:262-269` and `383-389`).
- Atomic JSON persistence is repeated for queues, policies, and MCP access.
- Constant-time string comparison is duplicated in `auth.ts` and `mcp-access.ts`.
- Status/running derivation is repeated across the server, MCP summarizer, root client, chat, and control cards, increasing the chance of disagreement.

### Magic numbers and hardcoded protocol strings

- Poll/retry/refresh timings are scattered: 650 ms, 1.2 s, 1.5 s, 4 s, 4.5 s, 20 s, 30 s, and several timeout values from 10 to 70 seconds.
- Retention/search bounds are scattered: 16/32/100/192 items, 30 file results, 4,000 scanned entries, depth 6, one-megabyte tails, 15-minute panel lifetime, and 24-hour live-state cleanup.
- Codex RPC method names, notification names, route fragments, local-storage keys, and status strings are repeated as raw literals. Central constants and discriminated event types would reduce typo/version risk.
- Some values are appropriately named (`SESSION_TTL_MS`, `COMPLETED_CONTROL_TTL_MS`), showing the pattern that should be extended.

### Other maintainability and reliability smells

- **Polling amplification:** the client reloads all thread pages every four seconds, the selected detail every 1.5 seconds, and each visible control-card detail every 1.5 seconds, in addition to SSE-triggered refreshes. With many sessions this can generate substantial Codex RPC and render load.
- **Unbounded retained identity/state:** MCP actors have no expiry/revocation cleanup; external trackers/call maps are not pruned; completion/local-storage maps can retain removed IDs.
- **Broad sync filesystem use:** persistence, authentication, MCP access, service scripts, and external monitoring use synchronous filesystem operations in the main server process. Small state writes are probably acceptable now, but procfs and rollout scans are more concerning.
- **Fragile systemd escaping:** `systemdEscape` only handles `%` and spaces. Tabs, newlines, and backslashes/path syntax are not robustly encoded. Unit generation should use a well-tested quoting/escaping strategy.
- **Installer configuration mismatch:** `scripts/install-service.mjs:15-20` always resolves `codex` through `bash` and ignores `CODEX_BIN`; the install script also does not load `.env`. This conflicts with `.env.example`/README guidance for hosts where Codex is not on the service PATH.
- **Installer completeness check:** it verifies only `build/server/index.js`, not `dist/index.html`, so a partial build can install a service that serves a 503 client page.
- **Accessibility:** session cards contain focusable `span role="button"` controls without keyboard handlers (`src/client/App.tsx:545-555`), and several icon buttons rely on `title` without an explicit accessible label. Native buttons should be used for independent actions without nesting interactive controls.
- **Time formatting:** `relativeReset` reports a reset under one hour as `in 0h`; minutes should be shown.
- **No automated style/quality gate:** there is no lint, format, coverage-threshold, or CI configuration. The unused import and unhandled async callback patterns therefore pass `npm run check`.

### README and documentation

The README is generally clear and accurate about requirements, install/build/start commands, service management, authentication defaults, workspace roots, MCP registration, and private-LAN security. The configuration table is unusually useful for a small project, and the warning around YOLO/plain HTTP is appropriately prominent.

Documentation gaps and inaccuracies:

- `CODEX_APP_SERVER_URL` and `CODEX_HOME` are used by source code but not documented. The former selects the durable WebSocket transport; the latter controls both the SQLite state location and sessions root.
- The `CODEX_BIN` guidance is not accurate for `npm run install-service`: the installer ignores the variable and requires `codex` to resolve through a login Bash PATH.
- Direct MCP registration (`node .../mcp.js`) does not automatically load the project `.env`; the README should explain that `FORGEDECK_URL` and a non-default token path must be supplied in the MCP client's environment.
- Development docs omit `npm test`, and the test command's build prerequisite/stale-build behavior is not explained.
- Platform behavior is not explicit. The service scripts require systemd/Linux, and definitive external-process liveness relies on Linux `/proc`; other platforms degrade to less reliable lifecycle detection.
- There is no troubleshooting section for missing Codex state DB, failed durable runtime connection, invalid workspace roots, service logs beyond the basic journal command, or how to rotate/revoke browser/MCP credentials.
- There is no architectural/API documentation for state files, route contracts, queue semantics, ownership lifecycle, or which data survives a dashboard/runtime restart.

## Recommendations

### Priority 0 — Correctness and uncaught errors

1. Make every async UI action return and await `Promise<void>`, and route failures through one error boundary/toast path. Change `onCreated`, `onRename`, `onArchive`, and logout prop types accordingly; add catches to runtime/list refresh callbacks. Enable a lint rule such as `@typescript-eslint/no-floating-promises` to prevent recurrence.
2. Always remove `bridgeOwnedThreads` in failure paths. Wrap resume/start operations in `try/finally` or add ownership only after a turn is confirmed started.
3. Normalize Codex RPC failures into a typed application error with an HTTP status, safe public message, code, and logged internal context. Add a JSON API 404 handler and return generic 5xx messages with a request/correlation ID.
4. Define the partial-success semantics of thread creation. Prefer a service method that records each completed step and either compensates safely or returns the created thread plus a structured warning when naming/initial prompt fails.
5. Guard local-storage and SSE parsing. Invalid stored values should be discarded per key; malformed/version-incompatible events should be logged and trigger a bootstrap refresh rather than throw.

### Priority 1 — Structure and contracts

6. Create an Express app factory with injected dependencies. Split routers by `auth`, `workspaces`, `threads`, `approvals`, and `mcp`; move queue/policy/live-state logic into services with explicit methods and invariants. Keep process startup/shutdown in a small entrypoint.
7. Split the React client by feature: API/SSE client, application/session store, shell/sidebar, control center, chat/transcript, composer, approvals, and new-session flow. Extract shared `useSessionComposer` and item renderers to remove Chat/ControlCard duplication.
8. Introduce shared request/response/event schemas, preferably using Zod already present in the project. Parse HTTP bodies, persisted JSON, Codex/MCP responses, SSE notifications, and local storage at runtime. Generate/infer client types from the same schemas.
9. Replace `ThreadItem` with a discriminated union and introduce a typed Codex event map. Avoid non-null assertions by explicitly handling missing root elements, empty model lists, absent goals, and invalid selections.
10. Refactor `CodexBridge` around an explicit state machine (`stopped`, `starting`, `ready`, `reconnecting`, `stopping`). Tear down failed transports, clear stale child/socket references, and test spawn/connect/initialize failure recovery.

### Priority 2 — Test strategy and tooling

11. Add API integration tests using an app factory and fake Codex transport. Cover status mapping, input schemas, ownership, creation failure, queues, approvals, SSE, and persistence recovery before refactoring behavior further.
12. Add unit/state-machine tests for `CodexBridge`, queue coordination, event reduction, and the full external monitor parser. Add React Testing Library/Vitest tests for critical UI flows and corrupt-boundary data.
13. Change `npm test` to compile first or run TypeScript tests directly. Add `test:coverage`, exclude test/generated files from production coverage, and establish initial per-module thresholds rather than relying only on a global number.
14. Add ESLint with TypeScript, React hooks, accessibility, unused-import, and promise rules; add a formatter and `lint` script. Enable `noUnusedLocals` and `noUnusedParameters` once existing findings are cleaned up. Consider `noUncheckedIndexedAccess` after the protocol types are strengthened.
15. Add CI that runs clean install, check, lint, tests/coverage, and build. A clean-build test will catch the current stale-artifact issue.

### Priority 3 — Performance, operations, and documentation

16. Make SSE the primary synchronized state path with a single backoff poll per disconnected client. Batch detail reads, stop reloading every visible card independently, and measure RPC volume with realistic session counts.
17. Move external monitoring work off the request event loop or make it incremental. Cache procfs liveness between slower scans, bound per-poll bytes/work, prune trackers and calls, and document non-Linux degradation.
18. Validate persisted records with versioned schemas and quarantine invalid files/entries. Add bounded retry with jitter and an explicit failed state for queued turns rather than leaving them silently stuck.
19. Add lifecycle/retention for MCP actors and ownership records, including revocation/rotation tools. Reset the cached actor promise after registration failure so MCP clients can recover.
20. Harden and test systemd unit generation. Respect `CODEX_BIN`, load the intended environment for installation, verify both server and client build artifacts, and use robust unit escaping.
21. Update README configuration/platform/test guidance, document MCP environment injection and restart/persistence semantics, and add short troubleshooting and architecture sections.
22. Promote important timing/size/retention values to named constants (and configuration only where operators genuinely need control). Centralize route, storage-key, and Codex method/event names to reduce drift.
