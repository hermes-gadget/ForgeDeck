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
- Desktop-first Control Center with live multi-session panels, adaptive 4/3/2/1-column layouts, and at most two rows per page
- Real-time agent messages, command executions and output, file changes, MCP calls, dynamic tools, and resilient polling fallback
- Search, pin, rename, archive, and sorting for large session collections
- Responsive desktop/mobile UI

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

The service restarts after crashes and starts with the user's systemd session. If this machine is configured to end user services on logout, an administrator can enable lingering with `loginctl enable-linger "$USER"`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORGEDECK_HOST` | `0.0.0.0` | HTTP listen address |
| `FORGEDECK_PORT` | `4173` | HTTP listen port |
| `FORGEDECK_AUTH` | `on` | Set to `off` to disable the ForgeDeck login |
| `FORGEDECK_PASSWORD` | generated token | ForgeDeck login password |
| `FORGEDECK_ROOTS` | current home directory | Colon-separated selectable workspace roots |
| `CODEX_BIN` | `codex` on `PATH` | Codex executable path |

The production start command and included systemd service automatically load `.env` when it exists.

## Security notes

- Keep `.data/`, `.env`, and `~/.codex/` out of version control. The supplied `.gitignore` already covers ForgeDeck's local secrets and build output.
- `FORGEDECK_AUTH=off` gives every device that can reach the service full control of Codex. Use it only on a trusted, firewalled LAN.
- ForgeDeck uses plain HTTP so phones and tablets can connect easily on the private LAN. Do not port-forward it to the internet or use it on an untrusted network. For remote access, put it behind a private VPN such as Tailscale or a TLS reverse proxy.
- Workspace sessions use Codex's `workspace-write` sandbox and request approval for elevated commands. ForgeDeck restricts each thread's runtime workspace root to the selected directory.
- Hidden and common credential directories are omitted from the browser and rejected as workspaces.

## Development

```bash
npm run dev       # Vite on :5173, server on :4173
npm run check     # client and server type checks
npm run build     # production bundles
npm audit         # dependency audit
```

ForgeDeck is intentionally a private package (`"private": true`). If you publish the source to GitHub, create the repository as private unless you deliberately want to share the code; no host credentials are required in the repository.
