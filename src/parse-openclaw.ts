// parse-openclaw.ts — OpenClaw 会话解析 → 统一 trace 模型
//
// OpenClaw 有两种 jsonl，都不是 claude 形态（之前被 renderClaude 当 claude 解析 →
// 0 events → 页面空）：
//   1. plain `<id>.jsonl`        实时会话日志：{type:"message", message:{role,content[]}}
//                                + session / model_change / thinking_level_change / custom 元记录
//   2. `<id>.trajectory.jsonl`   轨迹快照：session.started / context.compiled /
//                                prompt.submitted / model.completed，对话在 data.messages[]
//                                / data.messagesSnapshot
//
// 注意 block / 工具形态与 claude **不同**，不能复用 parse-claude.blocksOf：
//   - 工具调用 = content block {type:"toolCall", id, name, arguments}（claude 是 tool_use+input）
//   - 工具结果 = 独立 message，message.role="toolResult"，message 级带 toolCallId/toolName/
//     isError，content=[{type:"text",text}]（claude 是 content block type:"tool_result"，role user）
//   - thinking = {type:"thinking", thinking, thinkingSignature}
import path from "node:path";
import { toText } from "./text.ts";
import type { Block, Rec, RenderResult, Role, TraceEvent } from "./types.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
function asRole(v: unknown): Role {
  return v === "user" || v === "assistant" || v === "system" || v === "developer" || v === "tool"
    ? v : "assistant";
}
// trajectory 的 message.timestamp 是 epoch 毫秒；plain 的 timestamp 已是 ISO。
function tsOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && v > 0) { try { return new Date(v).toISOString(); } catch { return ""; } }
  return "";
}

// openclaw content[] → blocks（处理 openclaw 自有的 toolCall / thinking 形态）。
function ocBlocksOf(content: unknown): Block[] {
  const out: Block[] = [];
  if (content == null) return out;
  if (typeof content === "string") { if (content.trim()) out.push({ kind: "text", text: content }); return out; }
  if (!Array.isArray(content)) { out.push({ kind: "text", text: String(content) }); return out; }
  for (const b of content as Rec[]) {
    if (!b || typeof b !== "object") { out.push({ kind: "text", text: String(b) }); continue; }
    switch (b.type) {
      case "text": out.push({ kind: "text", text: str(b.text) }); break;
      case "thinking": {
        const tk = str(b.thinking);
        out.push({ kind: "thinking", text: tk.trim() ? tk : "(thinking 内容为空)" });
        break;
      }
      case "toolCall": { // openclaw 工具调用形态
        let input: unknown = b.arguments;
        if ((input == null || input === "") && typeof b.partialArgs === "string") {
          try { input = JSON.parse(b.partialArgs); } catch { input = b.partialArgs; }
        }
        out.push({ kind: "tool_use", id: b.id ? str(b.id) : undefined, name: str(b.name) || "tool", input: input ?? {} });
        break;
      }
      case "tool_use": out.push({ kind: "tool_use", id: b.id, name: b.name ?? "tool", input: b.input ?? {} }); break;
      case "tool_result":
        out.push({ kind: "tool_result", toolUseId: b.tool_use_id ?? b.toolCallId, ok: !(b.is_error ?? b.isError), text: toText(b.content) });
        break;
      case "image": out.push({ kind: "image" }); break;
      default: out.push({ kind: str(b.type) || "block", text: toText(b.content ?? b.text) });
    }
  }
  return out;
}

// 一条 openclaw message（plain 的 r.message，或 trajectory 的 messagesSnapshot[i]）→ 事件。
// toolResult 是独立 message（工具结果在 message 级字段 + content 文本）→ tool 角色 + tool_result block。
function messageToEvent(msg: Rec, seq: number, ts: string, model: string): TraceEvent | null {
  const role = msg.role;
  if (role === "toolResult" || role === "tool") {
    const block: Block = {
      kind: "tool_result",
      toolUseId: str(msg.toolCallId ?? msg.tool_call_id) || undefined,
      toolName: str(msg.toolName ?? msg.name) || "tool",
      ok: !(msg.isError ?? msg.is_error),
      text: toText(msg.content),
    };
    return { seq, role: "tool", ts, blocks: [block] };
  }
  const blocks = ocBlocksOf(msg.content);
  if (blocks.length === 0) return null;
  const r = asRole(role);
  const ev: TraceEvent = { seq, role: r, ts, blocks };
  if (r === "assistant") {
    const m = str(msg.model) || model;
    if (m) ev.model = m;
    if (msg.usage) ev.usage = msg.usage;
  }
  return ev;
}

// 轨迹文件的判别标记（trace schema）。scan.detectFormat 也用同一组特征。
export function isOpenclawTrajectory(text: string): boolean {
  return /"traceSchema"|"type"\s*:\s*"(session\.started|prompt\.submitted|model\.completed|context\.compiled|trace\.metadata)"/.test(
    text.slice(0, 4000),
  );
}

export function renderOpenclaw(real: string, text: string): RenderResult {
  const records: Rec[] = [];
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { records.push(JSON.parse(line)); } catch {} }
  return isOpenclawTrajectory(text) ? renderTrajectory(real, records) : renderPlain(real, records);
}

function firstUserText(events: TraceEvent[]): string {
  const u = events.find((e) => e.role === "user");
  const t = u?.blocks?.find((b) => b.kind === "text");
  return t ? (t.text ?? "").slice(0, 120) : "";
}

// ---- plain `<id>.jsonl`（实时会话日志，主路径）----
function renderPlain(real: string, records: Rec[]): RenderResult {
  const events: TraceEvent[] = [];
  let seq = 0, model = "", cwd = "";
  let sessionId = path.basename(real, ".jsonl");
  for (const r of records) {
    const ts = tsOf(r.timestamp ?? r.ts);
    switch (r.type) {
      case "session":
        cwd = str(r.cwd) || cwd;
        if (r.id) sessionId = str(r.id);
        break;
      case "model_change": {
        model = str(r.modelId) || model;
        const label = (r.provider ? str(r.provider) + "/" : "") + str(r.modelId);
        events.push({ seq: seq++, role: "system", ts, inj: { itype: "model_change", hookName: "", meta: label, text: "model → " + label, trivial: false } });
        break;
      }
      case "thinking_level_change":
        events.push({ seq: seq++, role: "system", ts, inj: { itype: "thinking_level", hookName: "", meta: str(r.thinkingLevel), text: "thinking level → " + str(r.thinkingLevel), trivial: true } });
        break;
      case "custom": {
        const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? {}, null, 2);
        events.push({ seq: seq++, role: "system", ts, inj: { itype: "custom:" + str(r.customType), hookName: "", meta: str(r.customType), text: body, trivial: false } });
        break;
      }
      case "message": {
        const ev = messageToEvent(r.message ?? {}, seq, ts, model);
        if (ev) { events.push(ev); seq++; }
        break;
      }
      default: break;
    }
  }
  return {
    path: real,
    cwd,
    sessionId,
    title: firstUserText(events),
    count: events.length,
    events,
  };
}

// ---- `<id>.trajectory.jsonl`（轨迹快照，兜底路径）----
// 每个 prompt 周期的 messages[] 是累计快照，直接逐条 emit 会重复；取最完整的一份
// （messagesSnapshot / messages 里最长的）渲染，再把 systemPrompt 置顶为 SYS 节点。
function renderTrajectory(real: string, records: Rec[]): RenderResult {
  let best: Rec[] = [], systemPrompt = "", provider = "", model = "";
  let sessionId = path.basename(real, ".jsonl").replace(/\.trajectory$/, "");
  for (const r of records) {
    if (r.sessionId) sessionId = str(r.sessionId);
    if (r.provider) provider = str(r.provider);
    if (r.modelId) model = str(r.modelId);
    const d = (r.data ?? {}) as Rec;
    const msgs = Array.isArray(d.messagesSnapshot) ? d.messagesSnapshot
      : Array.isArray(d.messages) ? d.messages : null;
    if (msgs && msgs.length >= best.length) best = msgs as Rec[];
    if (d.systemPrompt && !systemPrompt) {
      const sp = d.systemPrompt;
      systemPrompt = typeof sp === "string" ? sp
        : sp && typeof sp === "object" && (sp as Rec).originalChars
          ? `(systemPrompt 已截断，原文约 ${(sp as Rec).originalChars} 字；轨迹文件不留全量)`
          : JSON.stringify(sp);
    }
  }

  const events: TraceEvent[] = [];
  let seq = 0;
  if (systemPrompt) {
    events.push({ seq: seq++, role: "system", ts: "", inj: { itype: "system_prompt", hookName: "", meta: (provider ? provider + "/" : "") + model, text: systemPrompt, trivial: false } });
  }
  for (const m of best) {
    const ev = messageToEvent(m, seq, tsOf(m.timestamp), model);
    if (ev) { events.push(ev); seq++; }
  }
  return {
    path: real,
    cwd: "",
    sessionId,
    title: firstUserText(events),
    count: events.length,
    events,
  };
}
