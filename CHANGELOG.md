# Changelog

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
