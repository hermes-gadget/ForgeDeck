# Security & PII Audit Report

## Summary

Issues found. The audit covered every `.ts`, `.tsx`, and `.mjs` file under `src/` and `scripts/`, the client stylesheet, and all requested documentation and configuration files. No committed credentials, hardcoded personal information, or user-specific home paths were found. Workspace selection uses canonical paths, MCP mutations are ownership-gated, tokens use cryptographically secure randomness, React rendering resists the tested XSS payloads, and the installed dependency tree currently has no known `npm audit` advisories.

The main operational risk is that ForgeDeck binds to the LAN and transmits its login credential and session cookie over plain HTTP by default. Additional findings concern raw error disclosure, unbounded streaming/monitor state, cancellation and initialization races, and defense-in-depth around symlinks and long-lived MCP credentials.

## Issues Found

### 1. Login credentials and sessions are sent over plaintext LAN HTTP

- **Severity**: HIGH
- **File**: `src/server/index.ts`; `src/server/auth.ts`
- **Line**: `src/server/index.ts:17`, `src/server/index.ts:54-63`; `src/server/auth.ts:74-80`
- **Issue**: The server binds to `0.0.0.0` by default, accepts the access key over HTTP, and always creates the session cookie with `secure: false`. A passive attacker on an untrusted or compromised LAN can capture either the login credential or the 30-day session cookie. A stolen session grants control of Codex sessions and can enable danger-full-access/YOLO execution. The README warning reduces deployment ambiguity but does not provide a technical control.
- **Fix**: Default to `127.0.0.1`. For non-loopback binding, require TLS through a trusted reverse proxy or private VPN and set the cookie's `secure` attribute when HTTPS is in use. Add an explicit trusted-proxy/TLS configuration and reject plaintext non-loopback startup unless the operator deliberately acknowledges the risk.

### 2. Raw backend errors are disclosed to browser and MCP clients

- **Severity**: MEDIUM
- **File**: `src/server/index.ts`; `src/server/mcp.ts`
- **Line**: `src/server/index.ts:440-443`, `src/server/index.ts:458-463`, `src/server/index.ts:538-543`; `src/server/mcp.ts:232-234`, `src/server/mcp.ts:246-250`, `src/server/mcp.ts:274-280`
- **Issue**: Codex/runtime exception messages are forwarded verbatim through JSON errors, SSE runtime/queue events, and MCP tool errors. Depending on the originating exception, these messages can expose absolute host paths, workspace names, backend URLs, provider details, or request-derived content. The default MCP token-file error demonstrably includes the resolved local path.
- **Fix**: Log full errors only on the server. Return stable public error codes and sanitized messages to clients. Maintain an allowlist for expected validation errors and redact paths, URLs, authorization values, tokens, and provider payloads from all other browser/SSE/MCP errors.

### 3. SSE broadcasting and retained live output allow memory exhaustion

- **Severity**: MEDIUM
- **File**: `src/server/index.ts`
- **Line**: `630-633`, `681-687`
- **Issue**: `broadcast()` ignores the return value of `Response.write()`, so a slow authenticated SSE client can accumulate an unbounded server-side write buffer. Agent and tool deltas are also appended to strings without byte limits. Large command output combined with a slow or abandoned client can exhaust Node.js memory and terminate the dashboard.
- **Fix**: Enforce per-item and per-thread byte caps, retain only a bounded tail, and truncate with an explicit marker. Track `write()` backpressure, resume on `drain`, and disconnect clients whose buffered data or lag exceeds a defined limit. Remove clients on response errors as well as request close.

### 4. The external monitor retains unbounded state and can allocate an unbounded file delta

- **Severity**: MEDIUM
- **File**: `src/server/external-monitor.ts`
- **Line**: `24-25`, `50-54`, `95-101`, `196-212`
- **Issue**: The monitor allocates `stat.size - tracker.offset` bytes in one operation. A rollout that grows sharply can therefore cause a very large allocation. Completed calls remain in `tracker.calls`, and trackers that fall out of the latest 32 database rows are never evicted, so tool output and tracker state grow for the lifetime of the service.
- **Fix**: Read in fixed-size chunks with a maximum amount per poll, cap individual output fields, delete completed calls after moving a bounded summary to `recent`, and evict trackers no longer present in the monitored row set after a short grace period.

### 5. Queue deletion can race with queue draining and still execute a removed task

- **Severity**: MEDIUM
- **File**: `src/server/index.ts`
- **Line**: `318-328`, `515-545`
- **Issue**: `drainQueue()` keeps a reference to the old queue and awaits `thread/resume` and `turn/start`. During either await, the delete endpoint can report successful removal. The drain then still starts the selected task; with multiple entries it can also write its stale array back and resurrect a removed entry. This violates the user's cancellation decision and can cause an unwanted prompt—and resulting commands—to run.
- **Fix**: Serialize queue mutations per thread. Mark an entry as claimed before awaiting, make deletion return a conflict once execution has been claimed, and re-check that the same entry is still the queue head immediately before `turn/start`. Persist and broadcast each state transition atomically.

### 6. External rollout reads trust database paths and follow symlinks

- **Severity**: LOW
- **File**: `src/server/external-monitor.ts`
- **Line**: `62-99`, `274-299`
- **Issue**: `rollout_path` is taken from the Codex SQLite database and passed to `statSync`/`openSync` without proving that its canonical target is a regular file under `sessionsRoot`. Both calls follow symlinks, and the separate stat/open operations permit a time-of-check/time-of-use swap. A process able to tamper with same-user Codex state could make ForgeDeck read another same-user file; JSONL-shaped contents could then be emitted to connected clients.
- **Fix**: Canonicalize both the sessions root and candidate, enforce path containment, reject non-regular files and symlinks with `lstat`, open with `O_NOFOLLOW` where supported, and `fstat` the opened descriptor before reading. Use the descriptor's size rather than a path-level stat.

### 7. Recursive file autocomplete has a symlink-swap traversal window

- **Severity**: LOW
- **File**: `src/server/paths.ts`
- **Line**: `83-96`
- **Issue**: The initial working directory is canonicalized, and existing symlink entries are skipped, but queued child directory paths are not canonicalized again before later traversal. A writable directory can be replaced with a symlink after `readdir` identifies it as a directory and before the queued path is scanned. This can expose file and directory names outside the configured root through autocomplete.
- **Fix**: Resolve and containment-check every directory immediately before opening it, reject symlinks, and keep a visited set of canonical paths. Consider descriptor-relative traversal with no-follow semantics to close the replacement race fully.

### 8. MCP actor credentials never expire or support revocation

- **Severity**: LOW
- **File**: `src/server/mcp-access.ts`
- **Line**: `35-43`, `51-59`, `94-118`
- **Issue**: Actor records are permanent. `lastSeenAt` is updated in memory but is neither used for expiry nor persisted after authentication. A leaked actor token therefore retains read access to all sessions and mutation access to its owned sessions indefinitely; unused actor records also accumulate permanently.
- **Fix**: Add actor expiry, pruning, explicit revocation, and token rotation. Persist last-seen information at a throttled interval, remove ownership records for deleted/missing threads, and document the actor lifetime.

### 9. The full Codex account response is passed through to clients

- **Severity**: LOW
- **File**: `src/server/index.ts`; `src/client/App.tsx`
- **Line**: `src/server/index.ts:111-118`; `src/client/App.tsx:448-450`
- **Issue**: ForgeDeck forwards the complete `account/read` response and intentionally displays the account email. This is not hardcoded PII, but it exposes runtime PII to every authenticated browser and makes future account-response fields visible automatically. MCP actors can also call the read-only bootstrap endpoint, even though the bundled MCP tool does not display the email.
- **Fix**: Construct a minimal response containing only fields the UI needs, such as `email`, `planType`, and `requiresOpenaiAuth`. Consider omitting email from MCP-authenticated bootstrap responses or moving human account details to a browser-only endpoint.

### 10. Concurrent reconnect requests can bypass Codex bridge initialization

- **Severity**: LOW
- **File**: `src/server/codex-bridge.ts`
- **Line**: `32-40`, `43-53`, `57-63`
- **Issue**: `start()` checks whether a child/socket exists before checking `startPromise`. During launch, `spawnChild()` assigns `this.child` before initialization completes. A concurrent request during reconnect can therefore return from `start()` immediately and send an RPC before the bridge has completed `initialize`, producing misordered requests and inconsistent runtime state.
- **Fix**: Check and await `startPromise` first. Track a separate initialized/ready state and do not treat an assigned child or open socket as ready until initialization and the `initialized` notification have completed.

## No Issues Found

- No PII found in hardcoded source values: no personal email addresses, real names, usernames, or user-specific home directories. `/home/you` in `.env.example` and `/absolute/path/...` in the README are generic placeholders.
- No hardcoded secrets found. `replace-me` and `a-secure-test-password` are obvious example/test values, not live credentials.
- No disallowed hardcoded IP addresses found. `127.0.0.1` and `0.0.0.0` are defaults; `192.168.x.x` is a symbolic documentation example rather than an address.
- No API key, access token, bearer token, or password value is embedded in production code.
- No direct Express route injection or ordinary `..` workspace traversal was found. Selected workspace paths are canonicalized with `realpath`, checked for root containment, and filtered for credential directories.
- No authentication or MCP ownership bypass was found. Session identifiers are unguessable, login comparison is timing-safe for equal-length values, and all MCP mutation routes under `/threads/:threadId` are gated by recorded ownership.
- No command injection was found in the Codex bridge or MCP server. Codex is spawned with an argument array and no shell; MCP values are serialized as JSON or URL-encoded.
- No exploitable React XSS sink was found. There is no `dangerouslySetInnerHTML`; ordinary values are React-escaped; raw HTML in Markdown is escaped; unsafe Markdown URLs were rendered with an empty `href`; and the CSP disallows inline scripts.
- No weak secret generation was found. Access/session/MCP tokens use `crypto.randomBytes` with 192 or 256 bits of entropy, and actor IDs use `crypto.randomUUID`.
- No file descriptor leak was found in `external-monitor.ts`; both explicit file opens close descriptors in `finally`, and the SQLite database is closed during shutdown.
- `.data/`, `.env`, `.env.*`, build output, logs, and editor metadata are excluded by `.gitignore`; no `.data` or real `.env` file is tracked. `.env.example` contains placeholders only.
- `npm audit --json` reported zero known vulnerabilities across the current 303-package installed dependency tree on 2026-07-13.
- `npm run check`, `npm run build`, and all 12 automated tests completed successfully. A targeted server-rendering probe escaped raw HTML and neutralized a `javascript:` Markdown link.

## Verdict

**Yes — the current repository contents are safe to push to a public GitHub repository from a PII and secret-exposure perspective.** No real credentials, personal identifiers, user-specific paths, or tracked runtime data were found, and the ignore rules correctly cover generated secrets.

Publishing the code is distinct from exposing a running instance. ForgeDeck should remain on loopback or a trusted private network, and it should not be exposed to the public internet or an untrusted LAN until the HIGH plaintext-transport issue is fixed. The MEDIUM findings should also be addressed before treating the service as hardened against malicious authenticated clients or hostile local state.
