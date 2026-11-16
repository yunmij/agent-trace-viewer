# Changelog

## Unreleased

- Account labels on session rows and project / account filtering. Codex sessions show per-session account IDs mapped to the signed-in email or a custom note; Claude shows one shared machine identity; OpenClaw and Hermes have no account concept.
- Batch project migration for Claude Code, Codex and OpenClaw, plus account migration for Codex sessions. Claude account migration and Hermes (SQLite) remain unsupported.
- Automatic per-file backups under `~/.agent-trace-viewer/backups` and batch rollback with sha256 drift detection; rollback aborts without touching files when a session has changed since the migration.
- New HTTP endpoints: `GET /api/identity`, `POST /api/identity/notes`, `POST /api/migrate`, `GET /api/migrations` (`?withOps=1&rollbacks=1`) and `POST /api/migrations/rollback`. Migration and rollback responses are projected to a public allowlist; internal ledger fields (`postHash`, `backup`, `destCandidates`) never leave the server.
- Security wording clarified: the tool is read-only by default; migration writes are limited to session `.jsonl` files, are backed up automatically and are rollbackable.
- `npm run demo` now includes two-account Codex fixtures plus demo auth, credentials and account-note files.

## 1.0.0

First public release.

- Session list for Claude Code, Codex, OpenClaw and Hermes, titled by the first real prompt, with project folder, age and size.
- Agent filter pills with counts, per-source filter, multi-word search, auto-refresh.
- Collapsible trace cards: thinking, tool calls / results paired by id, errors, token usage, hook and context injections; system noise hidden by default.
- In-session search with highlight and Enter / Shift+Enter navigation.
- Keyboard navigation (`/`, `j` / `k`, ↑ / ↓), light and dark themes, responsive layout.
- Timestamps shown in your local time zone.
- Extra inputs via `--root` or the Input sources panel; format detected from content.
- Secure defaults: binds to `127.0.0.1`, Host-header check against DNS rebinding, source changes only via `POST` + JSON, HTML output escaped.
- `npm run demo` with fictional sample sessions.
