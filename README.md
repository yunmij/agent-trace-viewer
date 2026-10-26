# agent-trace-viewer

Browse and visualize the session traces your AI coding agents leave on disk — **Claude Code**, **Codex**, **OpenClaw** and **Hermes** — in a local web UI.

Zero runtime dependencies (Node built-ins only), read-only, never phones home.

[中文说明](#中文说明)

## Quick start

```bash
npx agent-trace-viewer
# or install globally
npm i -g agent-trace-viewer
agent-trace-viewer          # short alias: atv
```

Then open <http://localhost:8787>.

## Features

- **One list for every agent** — sessions from all sources, newest first, titled by the first real user prompt, with project folder, size and age.
- **Filter & search** — agent pills with counts, per-source filter, multi-term search over title / session id / project / path, optional auto-refresh.
- **Readable traces** — user / assistant / tool / system cards, collapsible; thinking, tool calls and tool results paired by id, token usage, hook and context injections. Noise (trivial system ticks) hidden by default.
- **Find in session** — highlight every match, jump with Enter / Shift+Enter.
- **Keyboard first** — `/` to search, `j` / `k` (or ↑ / ↓) to move between sessions.
- **Light & dark themes**, follows your system by default.
- **Any `.jsonl`** — point it at extra folders or single files; the format (Claude / Codex / OpenClaw) is detected from content.

## Options

```
-p, --port <n>       Port to listen on (default 8787, env PORT)
    --host <addr>    Address to bind (default 127.0.0.1, env HOST)
    --root <path>    Extra input: a directory or a single .jsonl file. Repeatable.
-v, --version        Print version
-h, --help           Show help
```

Extra sources can also be added or removed at runtime from the **Input sources** (folder icon) panel.

### Default sources

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` |
| OpenClaw | `~/.openclaw/agents/**/*.jsonl` |
| Hermes | `~/.hermes/state.db` (SQLite, needs Node ≥ 22.5) |

## Security

Agent transcripts often contain source code, file paths and sometimes secrets. By default the server:

- listens on **127.0.0.1 only**, and rejects requests whose `Host` header is not a loopback name (blocks DNS-rebinding);
- only reads `.jsonl` files under the configured sources;
- accepts source changes only as `POST` + `application/json`, so other websites can't trigger them.

`--host 0.0.0.0` exposes **every local session** to your network — only use it on networks you trust.

## HTTP API

| Endpoint | Description |
|---|---|
| `GET /api/sessions` | Rescan and list sessions |
| `GET /api/render?path=<path>` | Structured trace for one session |
| `GET /api/inputs` | List input sources |
| `POST /api/inputs` `{"add": "<path>"}` / `{"remove": "<path>"}` | Add / remove an extra source |

## Development

```bash
npm install
npm start            # runs the .ts sources directly (Node ≥ 22.18 type stripping)
npm run typecheck
npm run build        # tsc → dist/ (what gets published; runs on Node ≥ 18)
```

```
bin/agent-trace-viewer.ts   CLI entry
src/config.ts               sources, CLI args, help
src/scan.ts                 discover sessions + metadata (title / cwd / format)
src/parse-*.ts              per-agent parsers → unified trace model (src/types.ts)
src/render.ts               /api/render: path checks, cache, format dispatch
src/server.ts               HTTP routes + static files
src/pages.ts                HTML shells
web/                        browser JS/CSS, served as-is (no build step)
```

## License

MIT

---

## 中文说明

本地浏览 / 可视化 AI coding agent 的会话 trace，支持 **Claude Code / Codex / OpenClaw / Hermes**。零运行时依赖，只读，不联网。

```bash
npx agent-trace-viewer        # 打开 http://localhost:8787
```

- 所有 agent 的会话统一列表：以首条真实用户输入作为标题，显示项目目录、大小和时间
- 按 agent 或输入源筛选，多关键词搜索（空格表示 AND），支持自动刷新
- trace 卡片可折叠：thinking、工具调用和结果（按 id 配对）、token 用量、hook 注入；默认隐藏系统噪声
- 会话内搜索高亮，Enter / Shift+Enter 跳转；`/` 聚焦搜索，`j` / `k` 切换会话
- 亮色 / 暗色主题；`--root` 或页面上的「Input sources」面板可以添加任意目录或单个 `.jsonl`

**安全**：默认只监听 `127.0.0.1`，并校验 Host 头防 DNS rebinding。`--host 0.0.0.0` 会把本机全部会话开放给局域网，只在可信网络里用。
