# ForgeDeck

ForgeDeck is a private, local-first web command deck for running many Codex sessions at once. Pick a workspace, choose from the models and reasoning levels available on your Codex account, and leave turns running after every browser tab has closed.

The browser never receives `~/.codex/auth.json`, API keys, or ChatGPT tokens. ForgeDeck talks to the installed `codex app-server`, which continues using the host's existing Codex login and session store.

## What it includes

- Persistent Codex threads that survive browser disconnects and server restarts
- Account-native model and reasoning choices loaded dynamically from Codex
- Live account plan usage percentage and reset time
- LAN access on `0.0.0.0:4173` (including `192.168.x.x` addresses)
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

Requirements: Node.js 22+ and a logged-in Codex CLI.

```bash
npm install
npm run build
npm start
```

On first start, ForgeDeck creates a random access key at `.data/access-token` and prints the local and LAN URLs. The `.data` directory and all `.env` files are ignored by git.

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
| `FORGEDECK_HOST` | `0.0.0.0` | HTTP listen address |
| `FORGEDECK_PORT` | `4173` | HTTP listen port |
| `FORGEDECK_AUTH` | `on` | Set to `off` to disable the ForgeDeck login |
| `FORGEDECK_PASSWORD` | generated token | ForgeDeck login password |
| `FORGEDECK_ROOTS` | current home directory | Colon-separated selectable workspace roots |
| `FORGEDECK_DATA_DIR` | `.data` | Runtime state and credential directory |
| `FORGEDECK_COOKIE_SECURE` | `auto` | `auto`, `on`, or `off` for the session cookie's Secure flag |
| `FORGEDECK_TRUST_PROXY` | `off` | Trust one reverse proxy hop for protocol and client IP detection |
| `FORGEDECK_TRUSTED_ORIGINS` | none | Comma-separated explicit HTTP(S) origins allowed by CORS |
| `FORGEDECK_RATE_LIMIT` | `300` | Maximum API requests per client and rate window |
| `FORGEDECK_SESSION_TTL_HOURS` | `24` | Idle-session archive age; `0` disables automatic archival |
| `FORGEDECK_QUEUE_MAX_MESSAGES` | `100` | Maximum persisted queued messages per session |
| `FORGEDECK_MODEL_CACHE_TTL_MS` | `30000` | Account model-list cache duration |
| `FORGEDECK_SLOW_REQUEST_MS` | `750` | API latency threshold for a warning; `0` disables warnings |
| `FORGEDECK_SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period before lingering connections are forced closed |
| `FORGEDECK_EXTERNAL_MONITOR` | `on` | Enable read-only monitoring of other local Codex sessions |
| `FORGEDECK_LOG_LEVEL` | `info` | Structured log threshold: `debug`, `info`, `warn`, or `error` |
| `CODEX_BIN` | `codex` on `PATH` | Codex executable path |
| `FORGEDECK_URL` | `http://127.0.0.1:4173` | Dashboard API URL used by the stdio MCP server |
| `FORGEDECK_MCP_TOKEN_FILE` | `.data/mcp-token` | MCP bootstrap token path for nonstandard installations |

The production start command and included systemd service automatically load `.env` when it exists.
See [`.env.example`](.env.example) for buffer limits, monitor tuning, build diagnostics, and compatibility aliases. Invalid values fail fast during startup instead of silently using unsafe settings.

## MCP server for AI-orchestrated sessions

ForgeDeck includes a local stdio MCP server. It exposes tools to browse allowed workspaces and model options, spawn sessions, inspect their progress, queue follow-up messages, stop them, toggle YOLO mode while idle, and remove them after completion. Every spawned session is a normal card in the same user-visible Control Center.

Build ForgeDeck, then register the server with Codex using an absolute path:

```bash
npm run build
codex mcp add forgedeck -- node /absolute/path/to/forgedeck/build/server/mcp.js
```

For another MCP client, configure an stdio server with `node` as the command and `/absolute/path/to/forgedeck/build/server/mcp.js` as its argument. The dashboard must be running. Set `FORGEDECK_URL` only when it does not use the default `http://127.0.0.1:4173`; the MCP bootstrap credential is read from `.data/mcp-token` by default.

Direct `node .../mcp.js` registrations do not automatically load the project `.env`; provide `FORGEDECK_URL` and `FORGEDECK_MCP_TOKEN_FILE` in that MCP client's environment. The `npm run mcp` wrapper does load `.env`.

Each MCP subprocess registers a separate actor credential. The ForgeDeck server records which sessions that actor created and enforces the boundary on every mutation. MCP callers have read-only access to user-created and other agents' sessions, while the user keeps normal Control Center access to everything. Ownership records survive dashboard restarts.

## Security notes

- Keep `.data/`, `.env`, and `~/.codex/` out of version control. The supplied `.gitignore` already covers ForgeDeck's local secrets and build output.
- Keep `.data/mcp-token` private. It is used only to mint isolated MCP actor credentials and is never sent to the browser.
- `FORGEDECK_AUTH=off` gives every device that can reach the service full control of Codex. Use it only on a trusted, firewalled LAN.
- ForgeDeck uses plain HTTP so phones and tablets can connect easily on the private LAN. Do not port-forward it to the internet or use it on an untrusted network. For remote access, put it behind a private VPN such as Tailscale or a TLS reverse proxy.
- Workspace sessions use Codex's `workspace-write` sandbox and request approval for elevated commands. ForgeDeck restricts each thread's runtime workspace root to the selected directory.
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

The authenticated `GET /api/diagnostics/performance` endpoint reports aggregate route latency and Codex bridge metrics without recording request bodies, query values, cookies, or tokens. `GET /api/health` remains a minimal unauthenticated liveness/degradation check. See [docs/API.md](docs/API.md) for the HTTP and SSE contract.

ForgeDeck is intentionally a private package (`"private": true`). If you publish the source to GitHub, create the repository as private unless you deliberately want to share the code; no host credentials are required in the repository.
