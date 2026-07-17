# ForgeDeck

ForgeDeck is a private, local-first web command deck for running many Codex and Claude Code sessions at once. Pick a workspace, choose from the models and reasoning levels available on your Codex or Claude account, and leave turns running after every browser tab has closed.

The browser never receives `~/.codex/auth.json`, API keys, or ChatGPT tokens. ForgeDeck talks to the installed `codex app-server` and `claude` CLI, which continue using the host's existing logins and session stores.

## What it includes

- Persistent Codex and Claude Code threads that survive browser disconnects and server restarts
- Account-native model and reasoning choices loaded dynamically from Codex and Claude
- Transparent Quick, Balanced, and Deep presets with manual model/effort control
- Live account plan usage percentage and reset time for Codex, Claude, and Spark
- Loopback-only networking by default, with explicit LAN acknowledgement and reverse-proxy origin controls
- Password-protected, HttpOnly browser sessions with login throttling
- Directory-only workspace browser with configurable roots and credential-folder blocking
- Live response streaming, command/file approval prompts, user questions, and stop controls
- Desktop-first Control Center with fixed card positions, full-height adaptive 4/3/2/1-column layouts, and at most two rows per page
- Real-time agent messages, command executions and output, file changes, MCP calls, dynamic tools, and resilient polling fallback
- A local MCP server that lets other AI agents spawn user-visible Codex sessions with a chosen workspace, model, reasoning effort, and YOLO policy
- Per-MCP-client ownership controls: agents may inspect all sessions but can message, stop, change, or remove only sessions they spawned themselves
- Server-retained live activity that restores running tool calls after a browser reconnect or refresh
- Read-only monitoring of other local Codex processes, including their active state and command/tool records
- Restored external-session user/assistant conversation history and colored unified file diffs
- Slash-command palette, native persistent `/goal` controls, and `@` workspace path autocomplete with keyboard selection
- Visible per-session queued messages that run in order only after the current turn finishes and survive browser closure or a ForgeDeck restart
- Pulsing orange completion indicators that remain until the finished session is opened
- Completed Control Center panels remain visible for 15 minutes, then leave the deck without deleting session history
- Search, pin, rename, archive, and sorting for large session collections
- Responsive desktop/mobile UI
- Automatic `/goal resume` recovery when Codex reports that the selected model is at capacity

## Run it

Requirements: Node.js 22+, a logged-in Codex CLI, and optionally a logged-in Claude Code CLI for Claude sessions.

```bash
npm install
npm run build
npm start
```

On first start, ForgeDeck creates a random access key at `.data/access-token` and prints its configured listen URL (loopback by default). The `.data` directory and all `.env` files are ignored by git.

To choose your own password, copy `.env.example` to `.env` and set `FORGEDECK_PASSWORD`. Passwords must be at least 12 characters.

## Keep it running

Install the included user-level systemd service:

```bash
npm run build
npm run install-service
```

Useful commands:

```bash
systemctl --user status forgedeck
journalctl --user -u forgedeck -f
systemctl --user restart forgedeck
npm run uninstall-service
```

The installer creates separate `forgedeck.service` and `forgedeck-codex.service` user units. The dashboard can restart and reconnect without stopping turns because the Codex app-server runtime remains alive independently. Both services restart after crashes and start with the user's systemd session. If this machine is configured to end user services on logout, an administrator can enable lingering with `loginctl enable-linger "$USER"`.

The service installer is Linux/systemd-specific. External-session liveness also uses Linux `/proc`; on other platforms ForgeDeck continues without that signal and reports monitor degradation through `/api/health` when the Codex state store is unavailable.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORGEDECK_HOST` | `127.0.0.1` | HTTP listen address; non-loopback values also require `FORGEDECK_ALLOW_LAN=on` |
| `FORGEDECK_PORT` | `4173` | HTTP listen port |
| `FORGEDECK_ALLOW_LAN` | `off` | Explicitly acknowledge a non-loopback network bind |
| `FORGEDECK_PUBLIC_ORIGIN` | listen URL | Canonical browser origin; required for wildcard binds and TLS proxies |
| `FORGEDECK_AUTH` | `on` | Set to `off` to disable the ForgeDeck login |
| `FORGEDECK_PASSWORD` | generated token | ForgeDeck login password |
| `FORGEDECK_AUTH_SESSION_TTL_HOURS` | `24` | Absolute browser-token lifetime; activity does not extend it |
| `FORGEDECK_AUTH_MAX_SESSIONS` | `32` | Maximum concurrent authenticated browser sessions |
| `FORGEDECK_LOGIN_MAX_ATTEMPTS` | `5` | Failed attempts allowed per client during the login window |
| `FORGEDECK_LOGIN_WINDOW_MS` | `900000` | Login throttling window |
| `FORGEDECK_ROOTS` | current home directory | Colon-separated selectable workspace roots |
| `FORGEDECK_DATA_DIR` | `.data` | Runtime state and credential directory |
| `FORGEDECK_COOKIE_SECURE` | `auto` | `auto`, `on`, or `off` for the session cookie's Secure flag |
| `FORGEDECK_TRUST_PROXY` | `off` | Trust one reverse-proxy hop for protocol and client IP detection |
| `FORGEDECK_TRUSTED_ORIGINS` | none | Additional exact HTTP(S) origins allowed to call the canonical origin with credentials |
| `FORGEDECK_RATE_LIMIT` | `300` | Maximum API requests per client and rate window |
| `FORGEDECK_SESSION_TTL_HOURS` | `24` | Idle-session archive age; `0` disables automatic archival |
| `FORGEDECK_QUEUE_MAX_MESSAGES` | `100` | Maximum persisted queued messages per session |
| `FORGEDECK_QUOTA_HEADROOM_PERCENT` | `10` | Provider quota percentage reserved before admitting another turn |
| `FORGEDECK_QUOTA_RESET_PROXIMITY_MS` | `300000` | Window used to flag a nearby quota reset and schedule waiting queues |
| `FORGEDECK_QUOTA_STALE_MS` | `300000` | Maximum age of a quota observation when it has no future reset timestamp |
| `FORGEDECK_ADMISSION_POLICY` | `wait` | Default exhaustion behavior: `wait` or `pause` |
| `FORGEDECK_COST_CATALOG_JSON` | none | Operator-supplied versioned model rates for optional cost estimates |
| `FORGEDECK_READ_MAX_CONCURRENT` | `16` | Maximum shared read/health operations before adaptive backpressure |
| `FORGEDECK_MUTATION_MAX_CONCURRENT` | `5` | Maximum shared mutation/archive operations before adaptive backpressure |
| `FORGEDECK_MAINTENANCE_CHUNK_SIZE` | `25` | Maximum TTL/retention items processed in one maintenance chunk |
| `FORGEDECK_MODEL_CACHE_TTL_MS` | `30000` | Account model-list cache duration |
| `FORGEDECK_SLOW_REQUEST_MS` | `750` | API latency threshold for a warning; `0` disables warnings |
| `FORGEDECK_SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period before lingering connections are forced closed |
| `FORGEDECK_EXTERNAL_MONITOR` | `on` | Enable read-only monitoring of other local Codex sessions |
| `FORGEDECK_LOG_LEVEL` | `info` | Structured log threshold: `debug`, `info`, `warn`, or `error` |
| `CODEX_BIN` | `codex` on `PATH` | Codex executable path |
| `FORGEDECK_CLAUDE_MAX_CONCURRENT` | `4` | Maximum concurrent Claude Code sessions |
| `FORGEDECK_CLAUDE_TTL_HOURS` | `2` | Idle Claude session archive age |
| `FORGEDECK_URL` | `http://127.0.0.1:4173` | Dashboard API URL used by the stdio MCP server |
| `FORGEDECK_MCP_TOKEN_FILE` | `.data/mcp-token` | MCP bootstrap token path for nonstandard installations |
| `FORGEDECK_MCP_CLIENT_ID` | `forgedeck-stdio` | Stable scope for one MCP actor; use a distinct value per independent client |

The production start command and included systemd service automatically load `.env` when it exists.
See the generated [configuration reference](docs/CONFIGURATION.md) for every runtime setting and intended default, and [`.env.example`](.env.example) for a deployment template. Invalid values fail fast during startup instead of silently using unsafe settings.

### Usage admission and budgets

ForgeDeck persists normalized request and token facts by run, model, workspace, and optional blueprint. Provider quota observations and retry-after signals are checked before the existing concurrency reservation, so interactive requests fail early and waiting queues wake at a known reset time instead of spinning. Configure run, workspace, or blueprint soft/hard limits through `/api/budgets`; alerts are emitted over the `admission` event stream.

Cost is always an estimate derived into a separate table from an operator-supplied, versioned catalog. `FORGEDECK_COST_CATALOG_JSON` rates are integer currency micros per one million tokens, keyed by the raw metrics `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningOutputTokens`, or `totalTokens`. Subscription percentages are never treated as currency spend.

The default exhaustion actions are `wait` and `pause`. `downgrade` and cross-provider `fallback` require a request-level `admissionPolicy` with `approved: true` and an exact provider/model target. ForgeDeck keeps Codex's provider fallback disabled and never changes a provider or model without that declaration. A fallback that cannot run inside an existing provider session is returned as a switch-required decision rather than being applied implicitly.

### LAN and reverse-proxy deployment

The safe default is loopback-only plain HTTP. To expose ForgeDeck directly on a trusted LAN, all three values must be deliberate:

```dotenv
FORGEDECK_HOST=0.0.0.0
FORGEDECK_ALLOW_LAN=on
FORGEDECK_PUBLIC_ORIGIN=http://192.168.1.20:4173
```

This sends the login key and browser cookie over plaintext HTTP. Use it only on a trusted, firewalled network; never port-forward this endpoint or expose it to guest Wi-Fi or the public internet.

For an HTTPS reverse proxy, keep the backend on loopback and configure its one externally visible origin:

```dotenv
FORGEDECK_HOST=127.0.0.1
FORGEDECK_PUBLIC_ORIGIN=https://deck.example.test
FORGEDECK_TRUST_PROXY=on
FORGEDECK_COOKIE_SECURE=on
```

The proxy must replace, rather than append untrusted values to, `X-Forwarded-For` and `X-Forwarded-Proto`, and it must pass `X-Forwarded-Proto: https`. Trusted-proxy mode accepts those values from one hop, so prevent clients from reaching the backend port directly. `FORGEDECK_TRUSTED_ORIGINS` is only for intentional credentialed cross-origin clients; it is not a substitute for `FORGEDECK_PUBLIC_ORIGIN` and should normally remain empty.

## MCP server for AI-orchestrated sessions

ForgeDeck includes a local stdio MCP server. It exposes tools to browse allowed workspaces, fixed presets, and model options; spawn sessions with either a preset or manual model/effort pair; inspect their progress; list/get/publish validated artifacts; inspect unmet completion gates; queue follow-up messages; stop them; toggle YOLO mode while idle; and remove them after completion. Every spawned session is a normal card in the same user-visible Control Center.

Build ForgeDeck, then register the server with Codex using an absolute path:

```bash
npm run build
codex mcp add forgedeck -- node /absolute/path/to/forgedeck/build/server/mcp.js
```

For another MCP client, configure an stdio server with `node` as the command and `/absolute/path/to/forgedeck/build/server/mcp.js` as its argument. The dashboard must be running. Set `FORGEDECK_URL` only when it does not use the default `http://127.0.0.1:4173`; the MCP bootstrap credential is read from `.data/mcp-token` by default. Set a distinct `FORGEDECK_MCP_CLIENT_ID` for each client that should have independent ownership.

Direct `node .../mcp.js` registrations do not automatically load the project `.env`; provide `FORGEDECK_URL` and `FORGEDECK_MCP_TOKEN_FILE` in that MCP client's environment. The `npm run mcp` wrapper does load `.env`.

ForgeDeck stores a scoped actor credential under `.data/mcp-actors/` with mode `0600`. Restarting the stdio subprocess reuses the actor; credential refresh and 401 recovery rotate the token without changing its actor ID or ownership. MCP callers have read-only access to user-created and other actors' sessions, while the user keeps normal Control Center access to everything. The MCP tools also support one-time ownership handoff, explicit identity revocation, and archival or release of owned sessions. See [MCP identity and threat model](docs/MCP_IDENTITY.md).

## Security notes

- Keep `.data/`, `.env`, and `~/.codex/` out of version control. The supplied `.gitignore` already covers ForgeDeck's local secrets and build output.
- Keep `.data/mcp-token` private. It is used only to mint isolated MCP actor credentials and is never sent to the browser.
- Keep `.data/mcp-actors/` private. Its files are bearer credentials scoped to an installation and MCP client identity.
- `FORGEDECK_AUTH=off` gives every process that can reach the service full control of Codex. Keep it on loopback unless the host is otherwise strongly isolated.
- Direct LAN mode is explicit and still uses plaintext HTTP. For remote or multi-device access, prefer a private VPN with HTTPS or a TLS reverse proxy configured as above.
- Workspace sessions use an exclusive lease by default so another session cannot work in the same or an overlapping directory at the same time. Read-only inspection sessions may share a workspace; active lease holders are visible in session cards and the workspace picker.
- Exclusive Codex sessions use the `workspace-write` sandbox and request approval for elevated commands. Read-only sessions use the read-only sandbox. ForgeDeck restricts each thread's runtime workspace root to the selected directory.
- New or idle/completed sessions can explicitly enable YOLO mode, which uses `danger-full-access` and disables approvals for subsequent turns.
- Hidden and common credential directories are omitted from the browser and rejected as workspaces.

## Development

```bash
npm run dev       # Vite on :5173, server on :4173
npm run check     # client and server type checks
npm run build     # production bundles
npm test          # build the server and run all unit tests
npm run test:coverage # emit Node's line/branch/function coverage report
npm run build:analyze # write dist/bundle-report.html
npm audit         # dependency audit
```

Production browser source maps are disabled by default. Set `FORGEDECK_SOURCEMAP=true` only when a deployment needs them. Markdown rendering is loaded as a separate chunk, keeping the initial application JavaScript smaller.

The authenticated `GET /api/diagnostics/performance` endpoint reports aggregate route latency, Codex bridge metrics, provider turn capacity, and shared-pool queue wait/saturation/backpressure metrics without recording request bodies, query values, cookies, or tokens. `GET /api/health` remains a minimal unauthenticated liveness/degradation check. See [docs/API.md](docs/API.md) for the HTTP and SSE contract.

ForgeDeck is intentionally a private package (`"private": true`). If you publish the source to GitHub, create the repository as private unless you deliberately want to share the code; no host credentials are required in the repository.
