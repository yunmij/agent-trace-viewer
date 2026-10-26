// parse-codex.ts — codex rollout-*.jsonl 解析 → 统一 trace 模型
import { codexText } from "./text.ts";
import { structMetaFromRecords, codexSessionId, META_RECORDS } from "./scan.ts";
import type { Rec, RenderResult, Role, TraceEvent } from "./types.ts";

export function renderCodex(real: string, text: string): RenderResult {
  const records: Rec[] = [];
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { records.push(JSON.parse(line)); } catch {} }

  // call_id -> 工具名
  const toolName: Record<string, string> = {};
  for (const r of records) {
    if (r.type === "response_item" && r.payload?.type === "function_call" && r.payload.call_id) toolName[r.payload.call_id] = r.payload.name || "tool";
  }

  let sessionId = codexSessionId(real), title = "", userTitle = "";
  let lastUsage: Rec | null = null, seq = 0;
  const events: TraceEvent[] = [];
  for (const r of records) {
    const ts = r.timestamp ?? "";
    if (r.type === "session_meta") {
      sessionId = r.payload?.id ?? sessionId;
      // base_instructions = codex 的系统提示词（对象 {text} 或字符串），置顶为可见 SYS 节点
      const bi = r.payload?.base_instructions;
      const biText = bi == null ? "" : (typeof bi === "string" ? bi : (bi.text ?? JSON.stringify(bi, null, 2)));
      if (biText) events.push({ seq: seq++, role: "system", ts, inj: { itype: "system_prompt", hookName: "", meta: biText.length + " chars", text: biText, trivial: false } });
      continue;
    }
    if (r.type === "turn_context") continue;
    if (r.type === "event_msg") {
      const u = r.payload?.info?.total_token_usage;
      if (r.payload?.type === "token_count" && u) lastUsage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens };
      if (r.payload?.type === "user_message" && r.payload.message && !userTitle) userTitle = String(r.payload.message).trim().slice(0, 120);
      continue; // event_msg 与 response_item 重复，只取 usage / 首条真实用户输入
    }
    if (r.type !== "response_item") continue;
    const p = r.payload || {};
    switch (p.type) {
      case "message": {
        const body = codexText(p.content);
        if (!body.trim()) break;
        const role: Role = p.role === "assistant" ? "assistant" : p.role === "user" ? "user" : "developer";
        if (role === "user" && !title) title = body.slice(0, 120);
        events.push({ seq: seq++, role, ts, blocks: [{ kind: "text", text: body }] });
        break;
      }
      case "reasoning": {
        const sum = Array.isArray(p.summary) ? p.summary.map((s: unknown) => (s && typeof s === "object" ? ((s as any).text ?? "") : String(s))).join("\n") : "";
        events.push({ seq: seq++, role: "assistant", ts, blocks: [{ kind: "thinking", text: sum || "(reasoning summary 为空；真实推理在 encrypted_content，不可见)" }] });
        break;
      }
      case "function_call":
      case "tool_search_call": {
        let input: unknown; try { input = JSON.parse(p.arguments); } catch { input = p.arguments ?? {}; }
        events.push({ seq: seq++, role: "assistant", ts, blocks: [{ kind: "tool_use", id: p.call_id, name: p.name || (p.type === "tool_search_call" ? "tool_search" : "tool"), input }] });
        break;
      }
      case "function_call_output":
      case "tool_search_output": {
        const out = p.output == null ? "" : (typeof p.output === "string" ? p.output : JSON.stringify(p.output));
        const ok = !/exited with code [1-9]|error|failed/i.test(out.slice(0, 200));
        events.push({ seq: seq++, role: "user", ts, blocks: [{ kind: "tool_result", toolUseId: p.call_id, ok, text: out, toolName: toolName[p.call_id] || "tool" }] });
        break;
      }
      default: break;
    }
  }
  if (lastUsage && events.length) {
    const lastAsst = [...events].reverse().find((e) => e.role === "assistant");
    if (lastAsst) lastAsst.usage = lastUsage;
  }
  const sm = structMetaFromRecords(records.slice(0, META_RECORDS));
  return { path: real, cwd: sm.cwd, sessionId, title: userTitle || title, count: events.length, events };
}
