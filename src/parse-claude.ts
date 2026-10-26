// parse-claude.ts — claude session.jsonl 解析：消息 block 拆分、attachment 注入解析、统一 trace 模型
import path from "node:path";
import { toText } from "./text.ts";
import { structMetaFromRecords, META_RECORDS } from "./scan.ts";
import type { Block, Injection, Rec, RenderResult, Role, TraceEvent } from "./types.ts";

// ---- content（string | block[]）拆成结构化 blocks ----
export function blocksOf(content: unknown): Block[] {
  const out: Block[] = [];
  if (content == null) return out;
  if (typeof content === "string") { if (content.trim()) out.push({ kind: "text", text: content }); return out; }
  if (!Array.isArray(content)) { out.push({ kind: "text", text: String(content) }); return out; }
  for (const b of content as Rec[]) {
    if (!b || typeof b !== "object") { out.push({ kind: "text", text: String(b) }); continue; }
    switch (b.type) {
      case "text": out.push({ kind: "text", text: b.text ?? "" }); break;
      case "thinking": {
        // transcript 落盘时 thinking 明文常被抹掉，仅保留 signature；给出占位说明而非空卡片。
        const tk: string = b.thinking ?? "";
        out.push({ kind: "thinking", text: tk.trim() ? tk : "(thinking 内容为空；本 transcript 仅保留 signature，无明文推理)" });
        break;
      }
      case "tool_use": out.push({ kind: "tool_use", id: b.id, name: b.name ?? "tool", input: b.input ?? {} }); break;
      case "tool_result":
        out.push({ kind: "tool_result", toolUseId: b.tool_use_id, ok: !b.is_error, text: toText(b.content) });
        break;
      case "image": out.push({ kind: "image" }); break;
      default: out.push({ kind: b.type || "block", text: toText(b.content ?? b.text) });
    }
  }
  return out;
}

// ---- attachment 记录 → 结构化注入 ----
function injContent(a: Rec): string {
  const c = a.content;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join("\n");
  if (typeof c === "string") return c;
  if (a.type === "mcp_instructions_delta") return (a.addedBlocks || []).join("\n\n");
  if (a.type === "deferred_tools_delta") return "added: " + (a.addedNames || []).join(", ") + (a.removedNames?.length ? "\nremoved: " + a.removedNames.join(", ") : "");
  if (a.type === "command_permissions") return "allowedTools: " + JSON.stringify(a.allowedTools || []);
  if (a.type === "hook_success") return [a.stdout, a.stderr].filter((s: unknown) => s && String(s).trim()).join("\n");
  // hook 拦截/非阻塞错误：正文在 blockingError 而非 content，否则整段拦截理由会丢失。
  if (a.type === "hook_blocking_error" || a.type === "hook_non_blocking_error") {
    const be = a.blockingError || {};
    const msg = be.blockingError || a.stderr || a.error || "";
    return [msg, be.command ? "command: " + be.command : ""].filter((s: unknown) => s && String(s).trim()).join("\n\n");
  }
  if (a.type === "skill_listing") return c != null ? String(c) : "";
  return c == null ? "" : JSON.stringify(c, null, 2);
}
function injMeta(a: Rec): string {
  if (a.type === "hook_success") return "exit=" + a.exitCode + " · " + a.durationMs + "ms";
  if (a.type === "hook_blocking_error" || a.type === "hook_non_blocking_error") {
    const cmd = a.blockingError?.command || "";
    return cmd ? path.basename(cmd.split(/\s+/)[0] || cmd) : (a.hookName || "");
  }
  if (a.type === "skill_listing") return (a.skillCount ?? "?") + " skills";
  if (a.type === "task_reminder") return (a.itemCount ?? 0) + " items";
  if (a.type === "deferred_tools_delta") return (a.addedNames || []).length + " tools";
  if (a.type === "mcp_instructions_delta") return (a.addedNames || []).join(", ");
  if (a.type === "command_permissions") return (a.allowedTools || []).length + " tools";
  return "";
}
export function parseInjection(a: Rec): Injection {
  const text = injContent(a);
  const trivial =
    a.type === "hook_success" && (a.exitCode === 0 || a.exitCode == null) &&
    !(a.stdout || "").replace(/[{}\s]/g, "") && !(a.stderr || "").trim() &&
    !(typeof a.content === "string" ? a.content.trim() : a.content);
  return { itype: a.type || "attachment", hookName: a.hookName || "", hookEvent: a.hookEvent || "", meta: injMeta(a), text, trivial: !!trivial };
}

// ---- claude transcript → 统一 trace 模型 ----
export function renderClaude(real: string, text: string): RenderResult {
  const records: Rec[] = [];
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { records.push(JSON.parse(line)); } catch {} }

  const toolName: Record<string, string> = {};
  for (const r of records) {
    const c = r.message?.content ?? r.content;
    if (Array.isArray(c)) for (const b of c) if (b && b.type === "tool_use" && b.id) toolName[b.id] = b.name;
  }

  const events: TraceEvent[] = [];
  let seq = 0, firstUser = "";
  for (const r of records) {
    const role = r.type;
    if (role === "attachment") { events.push({ seq: seq++, role: "system", ts: r.timestamp ?? r.ts ?? "", inj: parseInjection(r.attachment || {}) }); continue; }
    if (role === "queue-operation" || role === "last-prompt") continue;
    // 其余节点也渲染（完整无损）：mode / 后台 started·result / system(hook 汇总)
    const sysTs = r.timestamp ?? r.ts ?? "";
    if (role === "mode") {
      events.push({ seq: seq++, role: "system", ts: sysTs, inj: { itype: "mode", hookName: "", meta: "", text: "mode → " + (r.mode ?? "?"), trivial: false } }); continue;
    }
    if (role === "started") {
      events.push({ seq: seq++, role: "system", ts: sysTs, inj: { itype: "started", hookName: "", meta: r.agentId ?? "", text: "background task started\nkey=" + (r.key ?? "") + "\nagentId=" + (r.agentId ?? ""), trivial: true } }); continue;
    }
    if (role === "result") {
      const rt = typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? {}, null, 2);
      events.push({ seq: seq++, role: "system", ts: sysTs, inj: { itype: "result", hookName: "", meta: r.agentId ?? "", text: rt, trivial: false } }); continue;
    }
    if (role === "system") {
      const txt = r.subtype === "stop_hook_summary"
        ? "stop_hook_summary · hookCount=" + (r.hookCount ?? 0) + "\n" + JSON.stringify(r.hookInfos ?? [], null, 2)
        : JSON.stringify(r, null, 2);
      events.push({ seq: seq++, role: "system", ts: sysTs, inj: { itype: "system:" + (r.subtype ?? ""), hookName: "", meta: r.subtype ?? "", text: txt, trivial: false } }); continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = blocksOf(r.message?.content ?? r.content);
    for (const b of blocks) if (b.kind === "tool_result") b.toolName = toolName[b.toolUseId!] || "tool";
    if (role === "user" && !firstUser) { const t = blocks.find((b) => b.kind === "text"); if (t) firstUser = (t.text ?? "").slice(0, 120); }
    events.push({ seq: seq++, role: role as Role, ts: r.timestamp ?? r.ts ?? "", model: r.message?.model, usage: r.message?.usage, blocks });
  }
  const sm = structMetaFromRecords(records.slice(0, META_RECORDS));
  return { path: real, cwd: sm.cwd, sessionId: path.basename(real, ".jsonl"), title: firstUser || sm.title, count: events.length, events };
}
