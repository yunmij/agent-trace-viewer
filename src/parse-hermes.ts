// parse-hermes.ts — hermes 会话解析 → 统一 trace 模型
//
// 与 claude/codex 不同：hermes 不写 session.jsonl，会话持久化在 SQLite
// `~/.hermes/state.db`（sessions + messages 两张表）。这里用 node 内置的
// `node:sqlite`（Node 22.5+）读库，把每条 message 映射成统一的 TraceEvent，
// 并把 session 级元数据（system prompt / token / 成本 / git / lineage）补成
// 一个置顶的 SYS 节点。单库多会话，故用合成 ref `<db路径>::<sessionId>` 作为
// 列表/渲染的 path 键。
import { createRequire } from "node:module";
import { HERMES_DB } from "./config.ts";
import type { Block, Injection, RenderResult, Role, SessionRow, TraceEvent } from "./types.ts";

export const HERMES_REF_SEP = "::";

const require = createRequire(import.meta.url);
// node:sqlite 是 Node 22.5+ 的实验特性。旧 node 上 require 抛错 → 返回 null，
// hermes 数据源静默缺席，viewer 其余部分不受影响。
function loadSqlite(): { DatabaseSync: new (p: string, o?: unknown) => HermesDb } | null {
  try { return require("node:sqlite"); } catch { return null; }
}

interface HermesDb {
  prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[] };
  close(): void;
}

export function isHermesRef(p: string): boolean {
  return p.startsWith(HERMES_DB + HERMES_REF_SEP);
}
export function hermesRef(sessionId: string): string {
  return HERMES_DB + HERMES_REF_SEP + sessionId;
}

function openDb(): HermesDb | null {
  const mod = loadSqlite();
  if (!mod) return null;
  try { return new mod.DatabaseSync(HERMES_DB, { readOnly: true }); } catch { return null; }
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
function parseJson(v: unknown): unknown {
  if (v == null || v === "") return null;
  try { return JSON.parse(str(v)); } catch { return null; }
}
// hermes timestamp 是 epoch 秒（REAL）；统一成 ISO，与其它解析器的 ts 一致。
function tsIso(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  try { return new Date(n * 1000).toISOString(); } catch { return ""; }
}
function asRole(v: unknown): Role {
  return v === "user" || v === "assistant" || v === "system" || v === "developer" || v === "tool"
    ? v : "assistant";
}

// assistant 的思考文本：明文 reasoning_content/reasoning 优先；否则尝试
// reasoning_details(OpenRouter list) 里的明文；再否则 codex 加密推理给个标记。
function thinkingText(m: Record<string, unknown>): string {
  const direct = str(m.reasoning_content) || str(m.reasoning);
  if (direct.trim()) return direct;
  const rd = parseJson(m.reasoning_details);
  if (Array.isArray(rd) && rd.length) {
    const txt = rd
      .map((d) => (d && typeof d === "object" ? (str((d as any).text) || str((d as any).summary)) : ""))
      .filter(Boolean).join("\n");
    if (txt.trim()) return txt;
    return "(reasoning_details 无明文)";
  }
  const ci = parseJson(m.codex_reasoning_items);
  if (Array.isArray(ci) && ci.some((it) => it && typeof it === "object" && (it as any).type === "reasoning")) {
    return "(codex reasoning，加密不可见)";
  }
  return "";
}

// content 文本：直存 content 优先；为空时回退 codex_message_items(codex Responses
// 形态：[{type:"message",content:[{type:"output_text"|"text",text}]}] 或 {text}）。
function contentText(m: Record<string, unknown>): string {
  const c = str(m.content);
  if (c.trim()) return c;
  const items = parseJson(m.codex_message_items);
  if (Array.isArray(items)) {
    const parts: string[] = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const o = it as any;
      if (typeof o.text === "string") { parts.push(o.text); continue; }
      if (Array.isArray(o.content)) {
        for (const seg of o.content) {
          if (seg && typeof seg === "object" && typeof (seg as any).text === "string") parts.push((seg as any).text);
        }
      }
    }
    if (parts.join("").trim()) return parts.join("\n");
  }
  return "";
}

// 一条 message 行 → blocks。thinking / text / tool_use(OpenAI tool_calls) /
// tool_result(role=tool)。
export function blocksForMessage(m: Record<string, unknown>): Block[] {
  const blocks: Block[] = [];
  const think = thinkingText(m);
  if (think.trim()) blocks.push({ kind: "thinking", text: think });

  if (m.role === "tool") {
    blocks.push({
      kind: "tool_result",
      toolUseId: str(m.tool_call_id) || undefined,
      toolName: str(m.tool_name) || "tool",
      ok: true,
      text: contentText(m),
    });
    return blocks;
  }

  const content = contentText(m);
  if (content.trim()) blocks.push({ kind: "text", text: content });

  const tcs = parseJson(m.tool_calls);
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      const o = tc as Record<string, any>;
      const fn = (o.function && typeof o.function === "object" ? o.function : {}) as Record<string, any>;
      const name = str(fn.name) || str(o.name) || "tool";
      const rawArgs = fn.arguments ?? o.arguments;
      let input: unknown;
      if (typeof rawArgs === "string") { try { input = JSON.parse(rawArgs); } catch { input = rawArgs; } }
      else input = rawArgs ?? {};
      blocks.push({ kind: "tool_use", id: o.id ? str(o.id) : undefined, name, input });
    }
  }
  return blocks;
}

// session 级元数据 → 置顶 SYS 节点（system prompt 正文 + 一行汇总）。
function sessionMetaInjection(s: Record<string, unknown>): Injection {
  const sys = str(s.system_prompt);
  const bits: string[] = [];
  if (s.model) bits.push("model=" + str(s.model));
  const inTok = num(s.input_tokens), outTok = num(s.output_tokens);
  const cacheR = num(s.cache_read_tokens), cacheW = num(s.cache_write_tokens), reas = num(s.reasoning_tokens);
  if (inTok || outTok || cacheR || cacheW || reas) {
    bits.push(`tokens in=${inTok} out=${outTok} cacheR=${cacheR} cacheW=${cacheW} reasoning=${reas}`);
  }
  const cost = num(s.actual_cost_usd) || num(s.estimated_cost_usd);
  if (cost) bits.push(`cost≈$${cost}`);
  if (num(s.tool_call_count)) bits.push("toolCalls=" + num(s.tool_call_count));
  if (num(s.api_call_count)) bits.push("apiCalls=" + num(s.api_call_count));
  if (s.cwd) bits.push("cwd=" + str(s.cwd));
  if (s.git_branch || s.git_repo_root) bits.push(`git=${str(s.git_branch)}@${str(s.git_repo_root)}`);
  if (s.parent_session_id) bits.push("parent=" + str(s.parent_session_id));
  if (s.end_reason) bits.push("end=" + str(s.end_reason));
  if (num(s.rewind_count)) bits.push("rewinds=" + num(s.rewind_count));
  const meta = bits.join(" · ");
  return {
    itype: "system_prompt",
    hookName: "",
    meta: meta || (sys ? sys.length + " chars" : "session meta"),
    text: sys || "(无 system prompt 记录)",
    trivial: false,
  };
}

function sessionUsage(s: Record<string, unknown>): Record<string, number> | null {
  const u: Record<string, number> = {
    input_tokens: num(s.input_tokens),
    output_tokens: num(s.output_tokens),
    cache_read_tokens: num(s.cache_read_tokens),
    cache_write_tokens: num(s.cache_write_tokens),
    reasoning_tokens: num(s.reasoning_tokens),
  };
  return Object.values(u).some((v) => v > 0) ? u : null;
}

// 纯函数：session 行 + 有序 message 行 → RenderResult。便于脱离 sqlite 单测。
export function buildHermesResult(
  ref: string,
  session: Record<string, unknown>,
  messages: Record<string, unknown>[],
): RenderResult {
  const model = str(session.model);
  let seq = 0, firstUser = "";
  const events: TraceEvent[] = [];

  // 置顶 SYS 节点：system prompt + session 级汇总（token/成本/git/lineage）。
  events.push({ seq: seq++, role: "system", ts: tsIso(session.started_at), inj: sessionMetaInjection(session) });

  for (const m of messages) {
    const blocks = blocksForMessage(m);
    if (blocks.length === 0) continue;
    const role = asRole(m.role);
    if (role === "user" && !firstUser) {
      const t = blocks.find((b) => b.kind === "text");
      if (t?.text) firstUser = t.text.slice(0, 120);
    }
    const ev: TraceEvent = { seq: seq++, role, ts: tsIso(m.timestamp), blocks };
    if (role === "assistant" && model) ev.model = model;
    // 压缩/失活的历史消息标注出来，避免被当成当前轮（仍展示，保持完整）。
    const flags: string[] = [];
    if (m.compacted) flags.push("compacted");
    if (m.active === 0) flags.push("inactive");
    const usage: Record<string, unknown> = {};
    if (num(m.token_count)) usage.token_count = num(m.token_count);
    if (m.finish_reason) usage.finish_reason = str(m.finish_reason);
    if (flags.length) usage.state = flags.join(",");
    if (Object.keys(usage).length) ev.usage = usage;
    events.push(ev);
  }

  // session 级 token 汇总挂到最后一个 assistant 事件（与 codex 一致的归属习惯）。
  const su = sessionUsage(session);
  if (su) {
    const lastAsst = [...events].reverse().find((e) => e.role === "assistant");
    if (lastAsst) lastAsst.usage = { ...(lastAsst.usage as object ?? {}), session_totals: su };
  }

  return {
    path: ref,
    cwd: str(session.cwd),
    sessionId: str(session.id),
    title: str(session.title) || firstUser,
    count: events.length,
    events,
  };
}

// 列出 state.db 里所有会话 → SessionRow[]（供 scan 合并进列表）。标题优先 sessions.title，
// 否则取首条 user 正文。
export function listHermesSessions(): SessionRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT s.id, s.cwd, s.message_count, s.started_at, s.ended_at, s.title,
              (SELECT m.content FROM messages m
                 WHERE m.session_id = s.id AND m.role = 'user'
                 ORDER BY m.id LIMIT 1) AS first_user
         FROM sessions s ORDER BY s.started_at DESC`,
    ).all();
    return rows.map((s) => {
      const id = str(s.id);
      const tsSec = num(s.ended_at) || num(s.started_at);
      const mtime = tsSec > 0 ? Math.round(tsSec * 1000) : 0;
      return {
        mtime,
        mtimeStr: mtime ? new Date(mtime).toLocaleString("sv-SE").slice(0, 19) : "",
        size: 0,
        lines: num(s.message_count),
        agent: "hermes",
        sessionId: id,
        title: (str(s.title) || str(s.first_user)).replace(/\s+/g, " ").trim().slice(0, 120),
        cwd: str(s.cwd),
        path: hermesRef(id),
      };
    });
  } catch { return []; }
  finally { try { db.close(); } catch { /* ignore */ } }
}

// 渲染单个会话：ref = `<db>::<sessionId>`。包含全部消息（含 compacted/inactive
// 历史），按写入顺序（id 升序）。
export function renderHermes(ref: string): RenderResult {
  const sessionId = ref.slice((HERMES_DB + HERMES_REF_SEP).length);
  const db = openDb();
  if (!db) return { path: ref, cwd: "", sessionId, title: "(node:sqlite unavailable, requires Node >= 22.5)", count: 0, events: [] };
  try {
    const sessions = db.prepare(`SELECT * FROM sessions WHERE id = ?`).all(sessionId);
    const session = sessions[0] ?? { id: sessionId };
    const messages = db.prepare(
      `SELECT role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count,
              finish_reason, reasoning, reasoning_content, reasoning_details,
              codex_reasoning_items, codex_message_items, active, compacted
         FROM messages WHERE session_id = ? ORDER BY id ASC`,
    ).all(sessionId);
    return buildHermesResult(ref, session, messages);
  } finally { try { db.close(); } catch { /* ignore */ } }
}
