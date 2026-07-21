---
name: verify
description: Launch an isolated ForgeDeck server instance and drive its HTTP API to verify changes end-to-end (sessions, Claude/Codex bridges, queues).
---

# Verifying ForgeDeck changes end-to-end

## Launch an isolated instance

Never point a test instance at the real data dir — a live ForgeDeck usually runs on :4173. Use a scratch data dir, scratch workspace root, a different port, and auth off:

```bash
S=/path/to/scratch; mkdir -p $S/fd-data $S/fd-ws
FORGEDECK_HOST=127.0.0.1 FORGEDECK_PORT=4599 FORGEDECK_AUTH=off \
FORGEDECK_DATA_DIR=$S/fd-data FORGEDECK_ROOTS=$S/fd-ws \
FORGEDECK_EXTERNAL_MONITOR=off FORGEDECK_LOG_LEVEL=info \
npx tsx src/server/index.ts > $S/server.log 2>&1 &
```

- To keep Codex out of the way when testing the Claude path, add `CODEX_BIN=/bin/false`; the server runs degraded but every non-Codex route works.
- Health: `GET /api/health` (503 "degraded" is expected with Codex disabled). Claude availability: `GET /api/account/status` → `backendStatus.claude.available`. The first availability probe can miss (cold start) and the false result is cached ~30s — durable create operations retry through it, or just wait 30s.

## Driving the API

- Create session: `POST /api/threads` `{cwd, provider: "claude"|"codex", model, reasoningEffort?, prompt?, name?}` → returns an operation; poll `GET /api/operations/:id` until `terminal: true`, `remoteThreadId` is the thread id.
- Read thread: `GET /api/threads/:threadId` → `thread.status.type` (`active`/`idle`), `thread.preview`, `thread.turns[].items`.
- Follow-up message: `POST /api/threads/:threadId/messages` `{text, model}` (Claude model is locked at creation; effort may change per message).
- Interrupt: `POST /api/threads/:threadId/command` `{"command":"stop"}`.
- Archive/cleanup: `DELETE /api/threads/:threadId`.

## Claude backend specifics

- Claude sessions live in tmux sessions named `claude-<threadId>` on the default socket. Inspect durable state with `tmux show-options -v -t claude-<threadId> @forgedeck_claude_session_id` (also `_active`, `_last_exit`, `_turn_state`, `_model`, `_effort`).
- `tmux capture-pane -J -t claude-<threadId> -p -S -100` shows the exact `claude -p` invocation and the result JSON.
- Archive the test session before finishing: a *restarting* live ForgeDeck adopts any orphaned `claude-*` tmux session at startup.
- Cheap real turns: `--model haiku`, low effort, prompts like "Reply with exactly: X".

## Gotchas

- `pkill -f "tsx src/server/index.ts"` exits 144; that's the signal, not a failure.
- The server persists durable operations in the data dir; a restarted test instance resumes incomplete creates automatically (useful for testing recovery).
