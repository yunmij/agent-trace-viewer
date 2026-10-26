#!/usr/bin/env node
// make-demo.mjs — 生成一套虚构的演示会话（claude / codex / openclaw），用于本地体验与 README 截图。
// 用法：node scripts/make-demo.mjs <dir>   → 在 <dir> 下造一个假的 HOME，再用 HOME=<dir> 启动即可。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "demo-home");
const NOW = Date.now();
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const J = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

function write(rel, recs, minAgo) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, J(recs));
  const t = new Date(NOW - minAgo * 60_000);
  fs.utimesSync(f, t, t);
}

// ---------- Claude Code ----------
function claude(id, cwd, minAgo, turns) {
  let n = 0;
  const base = { sessionId: id, cwd, version: "2.1.0" };
  const recs = [];
  const ts = () => iso(minAgo + 30 - n++ * 0.4);
  recs.push({ type: "attachment", timestamp: ts(), attachment: { type: "hook_success", hookName: "SessionStart:startup", hookEvent: "SessionStart", exitCode: 0, durationMs: 41 } });
  // 每轮：上一轮工具结果 / 用户输入 → 注入 → assistant 回复
  for (const t of turns) {
    if (t.results) recs.push({ ...base, type: "user", timestamp: ts(), message: { role: "user", content: t.results } });
    if (t.user) recs.push({ ...base, type: "user", timestamp: ts(), message: { role: "user", content: t.user } });
    if (t.hook) recs.push({ type: "attachment", timestamp: ts(), attachment: { type: "hook_additional_context", hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit", content: [t.hook] } });
    if (t.assistant) recs.push({ ...base, type: "assistant", timestamp: ts(), message: { role: "assistant", model: "claude-sonnet-4-5", content: t.assistant, usage: t.usage } });
  }
  return recs;
}

write(".claude/projects/-Users-demo-code-weather-app/7f3c2a91-5d4e-4b8a-9c1f-2e6d8a4b3c10.jsonl", claude(
  "7f3c2a91-5d4e-4b8a-9c1f-2e6d8a4b3c10", "/Users/demo/code/weather-app", 12, [
    {
      user: "The forecast page crashes when the API returns an empty `daily` array. Can you find the cause and fix it?",
      hook: "Project conventions: use pnpm, run `pnpm test` before finishing.",
      assistant: [
        { type: "thinking", thinking: "An empty `daily` array probably hits an unguarded `daily[0]` access. Let me look at the forecast component and the API adapter first." },
        { type: "text", text: "I'll start by locating where the forecast data is consumed." },
        { type: "tool_use", id: "toolu_01", name: "Grep", input: { pattern: "daily\\[0\\]", path: "src", output_mode: "content" } },
      ],
      usage: { input_tokens: 4210, output_tokens: 182, cache_read_input_tokens: 18320 },
    },
    {
      results: [{ type: "tool_result", tool_use_id: "toolu_01", content: "src/pages/Forecast.tsx:42:  const today = data.daily[0];\nsrc/pages/Forecast.tsx:43:  const high = today.temp.max;" }],
      assistant: [
        { type: "text", text: "Found it — `Forecast.tsx` reads `data.daily[0]` without checking the array is non-empty. Let me read the surrounding code." },
        { type: "tool_use", id: "toolu_02", name: "Read", input: { file_path: "/Users/demo/code/weather-app/src/pages/Forecast.tsx", offset: 30, limit: 30 } },
      ],
      usage: { input_tokens: 4630, output_tokens: 96, cache_read_input_tokens: 18320 },
    },
    {
      results: [{ type: "tool_result", tool_use_id: "toolu_02", content: "30\texport function Forecast({ data }: Props) {\n31\t  const units = useUnits();\n…\n42\t  const today = data.daily[0];\n43\t  const high = today.temp.max;\n44\t  const low = today.temp.min;" }],
      assistant: [
        { type: "tool_use", id: "toolu_03", name: "Edit", input: { file_path: "/Users/demo/code/weather-app/src/pages/Forecast.tsx", old_string: "  const today = data.daily[0];\n  const high = today.temp.max;", new_string: "  const today = data.daily.at(0);\n  if (!today) return <EmptyState message=\"No forecast available yet.\" />;\n  const high = today.temp.max;" } },
      ],
      usage: { input_tokens: 5120, output_tokens: 140, cache_read_input_tokens: 18320 },
    },
    {
      results: [{ type: "tool_result", tool_use_id: "toolu_03", content: "The file has been updated." }],
      assistant: [{ type: "tool_use", id: "toolu_04", name: "Bash", input: { command: "pnpm test -- Forecast", description: "Run forecast tests" } }],
      usage: { input_tokens: 5300, output_tokens: 48, cache_read_input_tokens: 18320 },
    },
    {
      results: [{ type: "tool_result", tool_use_id: "toolu_04", is_error: true, content: "FAIL src/pages/Forecast.test.tsx\n  ✕ renders empty state when daily is empty (12 ms)\n    Unable to find an element with the text: No forecast available" }],
      assistant: [
        { type: "thinking", thinking: "The test expects the text without the trailing \"yet.\" — the existing test fixture already defines the copy. Match it instead of changing the test." },
        { type: "tool_use", id: "toolu_05", name: "Edit", input: { file_path: "/Users/demo/code/weather-app/src/pages/Forecast.tsx", old_string: "No forecast available yet.", new_string: "No forecast available" } },
      ],
      usage: { input_tokens: 5610, output_tokens: 120, cache_read_input_tokens: 18320 },
    },
    {
      results: [{ type: "tool_result", tool_use_id: "toolu_05", content: "The file has been updated." }],
      assistant: [{ type: "tool_use", id: "toolu_06", name: "Bash", input: { command: "pnpm test -- Forecast", description: "Re-run forecast tests" } }],
      usage: { input_tokens: 5700, output_tokens: 44, cache_read_input_tokens: 18320 },
    },
    {
      results: [{ type: "tool_result", tool_use_id: "toolu_06", content: "PASS src/pages/Forecast.test.tsx\n  ✓ renders today's high and low (18 ms)\n  ✓ renders empty state when daily is empty (9 ms)\n\nTests: 2 passed, 2 total" }],
      assistant: [{ type: "text", text: "Fixed. `Forecast.tsx` now guards against an empty `daily` array and renders the existing **EmptyState** component instead of crashing.\n\n- `src/pages/Forecast.tsx`: use `daily.at(0)` and return early when it's missing\n- Tests: `pnpm test -- Forecast` → 2 passed" }],
      usage: { input_tokens: 5900, output_tokens: 160, cache_read_input_tokens: 18320 },
    },
  ]), 12);

write(".claude/projects/-Users-demo-code-api-gateway/b21e9d04-6a7f-4c3e-8d15-9f0a1b2c3d4e.jsonl", claude(
  "b21e9d04-6a7f-4c3e-8d15-9f0a1b2c3d4e", "/Users/demo/code/api-gateway", 95, [
    { user: "Add rate limiting to the /v1/search endpoint — 60 requests per minute per API key.",
      assistant: [{ type: "text", text: "I'll add a token-bucket limiter middleware keyed by API key." }, { type: "tool_use", id: "t1", name: "Glob", input: { pattern: "src/middleware/*.ts" } }],
      usage: { input_tokens: 3200, output_tokens: 70 } },
    { results: [{ type: "tool_result", tool_use_id: "t1", content: "src/middleware/auth.ts\nsrc/middleware/logging.ts" }],
      assistant: [{ type: "text", text: "Done — added `src/middleware/rateLimit.ts` and wired it into the search route. Requests over the limit get `429` with a `Retry-After` header." }],
      usage: { input_tokens: 3900, output_tokens: 210 } },
  ]), 95);

write(".claude/projects/-Users-demo-notes/c9a8b7d6-1e2f-4a3b-9c8d-7e6f5a4b3c2d.jsonl", claude(
  "c9a8b7d6-1e2f-4a3b-9c8d-7e6f5a4b3c2d", "/Users/demo/notes", 60 * 26, [
    { user: "Summarize this week's meeting notes into a short status update.",
      assistant: [{ type: "text", text: "Here's a concise status update covering the three projects discussed this week…" }],
      usage: { input_tokens: 2100, output_tokens: 320 } },
  ]), 60 * 26);

// ---------- Codex ----------
function codex(id, cwd, minAgo, prompt, items) {
  let n = 0;
  const ts = () => iso(minAgo + 20 - n++ * 0.5);
  return [
    { type: "session_meta", timestamp: ts(), payload: { id, cwd, cli_version: "0.40.0", base_instructions: { text: "You are Codex, a coding agent running in the user's terminal." } } },
    { type: "event_msg", timestamp: ts(), payload: { type: "user_message", message: prompt } },
    { type: "response_item", timestamp: ts(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    ...items.map((p) => ({ type: "response_item", timestamp: ts(), payload: p })),
    { type: "event_msg", timestamp: ts(), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 21840, output_tokens: 1320, cached_input_tokens: 15360 } } } },
  ];
}
write(".codex/sessions/2026/10/26/rollout-2026-10-26T09-12-40-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl", codex(
  "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "/Users/demo/code/cli-tool", 40,
  "Migrate the CLI argument parsing from yargs to node:util parseArgs.", [
    { type: "reasoning", summary: [{ type: "summary_text", text: "**Planning the migration** — list current yargs options, map each to parseArgs config, keep --help output identical." }] },
    { type: "function_call", call_id: "call_1", name: "shell", arguments: JSON.stringify({ command: ["rg", "-n", "yargs", "src"] }) },
    { type: "function_call_output", call_id: "call_1", output: "src/cli.ts:3:import yargs from 'yargs';\nsrc/cli.ts:12:  .option('verbose', { type: 'boolean' })" },
    { type: "function_call", call_id: "call_2", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: src/cli.ts\n-import yargs from 'yargs';\n+import { parseArgs } from 'node:util';\n*** End Patch" }) },
    { type: "function_call_output", call_id: "call_2", output: "Success. Updated the following files:\nM src/cli.ts" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Migrated `src/cli.ts` to `node:util` `parseArgs`; removed the `yargs` dependency. All 14 CLI tests pass." }] },
  ]), 40);
write(".codex/sessions/2026/10/25/rollout-2026-10-25T16-03-11-0199a0f1-aaaa-7bbb-8ccc-dddd0000eeee.jsonl", codex(
  "0199a0f1-aaaa-7bbb-8ccc-dddd0000eeee", "/Users/demo/code/weather-app", 60 * 20,
  "Write unit tests for the temperature unit conversion helpers.", [
    { type: "function_call", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: ["pnpm", "test", "units"] }) },
    { type: "function_call_output", call_id: "c1", output: "Tests: 8 passed, 8 total" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added 8 tests covering C↔F↔K conversions and rounding edge cases." }] },
  ]), 60 * 20);

// ---------- OpenClaw ----------
write(".openclaw/agents/main/sessions/5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170.jsonl", (() => {
  let n = 0; const ts = () => iso(60 * 3 + 10 - n++ * 0.5);
  return [
    { type: "session", id: "5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170", cwd: "/Users/demo/code/docs-site", timestamp: ts() },
    { type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-5", timestamp: ts() },
    { type: "message", timestamp: ts(), message: { role: "user", content: [{ type: "text", text: "Find broken links in the docs site and fix them." }] } },
    { type: "message", timestamp: ts(), message: { role: "assistant", content: [{ type: "thinking", thinking: "Run the link checker first, then patch the markdown sources." }, { type: "toolCall", id: "oc1", name: "exec", arguments: { command: "npx lychee docs/**/*.md" } }] } },
    { type: "message", timestamp: ts(), message: { role: "toolResult", toolCallId: "oc1", toolName: "exec", content: [{ type: "text", text: "✗ docs/guide/install.md → https://example.com/old-install (404)\n✗ docs/api/auth.md → ./tokens.md (file not found)\n2 errors" }] } },
    { type: "message", timestamp: ts(), message: { role: "assistant", content: [{ type: "text", text: "Fixed 2 broken links: updated the install URL and pointed `auth.md` at `./api-tokens.md`." }] } },
  ];
})(), 60 * 3);

console.log("demo sessions written to " + root);
