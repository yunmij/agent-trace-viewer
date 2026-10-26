// scan.ts — 数据源扫描：发现 .jsonl、抽取会话元数据（cwd / 标题 / format / 行数）、生成列表
import fs from "node:fs";
import path from "node:path";
import { toText, codexText } from "./text.ts";
import { CLAUDE_ROOT, OC_ROOT, CODEX_ROOT, allInputs } from "./config.ts";
import { listHermesSessions } from "./parse-hermes.ts";
import type { Rec, SessionRow, StructMeta } from "./types.ts";

interface FileMeta { mtimeMs: number; lines: number; cwd: string; title: string; format: "claude" | "codex" | "openclaw"; }
const fileMetaCache = new Map<string, FileMeta>();

// 取元数据时只看开头若干条记录：codex 开头常有大段 developer/环境注入，需多看几条才碰到真实提问。
export const META_RECORDS = 60;

function walk(dir: string, out: string[]): void {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

// 解析前 N 条 jsonl 记录（结构化取值用，避免扫全文）
function parseEarly(text: string, n: number): Rec[] {
  const recs: Rec[] = []; const lines = text.split("\n");
  for (let i = 0; i < lines.length && recs.length < n; i++) {
    const s = lines[i]; if (!s.trim()) continue;
    try { recs.push(JSON.parse(s)); } catch {}
  }
  return recs;
}

// 首条「真实」用户输入：跳过 <command-name> / <environment_context> / <system-reminder> 等注入包装。
function titleOf(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (!s || s.startsWith("<") || s.startsWith("# AGENTS.md")) return "";
  return s.slice(0, 120);
}

// 从已解析的开头若干条记录取 cwd + 标题。解析器手里已有全量 records，
// 直接传 records.slice(0, META_RECORDS) 即可，避免再 split + JSON.parse 一遍（大 jsonl 的关键省时点）。
//   cwd  : claude 记录上的 cwd / codex session_meta.payload.cwd / openclaw session.cwd · workspaceDir
//   title: 首条真实 user 文本
export function structMetaFromRecords(recs: Rec[]): StructMeta {
  let cwd = "", title = "";
  for (const r of recs) {
    if (!cwd) {
      if (r.type === "session_meta" && r.payload?.cwd) cwd = String(r.payload.cwd);
      else if (typeof r.cwd === "string") cwd = r.cwd;
      else if (typeof r.workspaceDir === "string") cwd = r.workspaceDir;
    }
    if (!title) {
      let ut = "";
      if (r.type === "user" && !r.isMeta) ut = toText(r.message ? r.message.content : r.content);
      else if (r.type === "message" && r.message && r.message.role === "user") ut = toText(r.message.content); // openclaw plain
      else if (r.type === "response_item" && r.payload && r.payload.type === "message" && r.payload.role === "user") ut = codexText(r.payload.content);
      else if (r.type === "event_msg" && r.payload && r.payload.type === "user_message") ut = String(r.payload.message || "");
      if (ut) title = titleOf(ut);
    }
    if (cwd && title) break;
  }
  return { cwd, title };
}

// 仅有原始文本时（如扫盘列表）用此变体。
export function structMeta(text: string): StructMeta {
  return structMetaFromRecords(parseEarly(text, META_RECORDS));
}

// codex rollout 文件名 rollout-<ts>-<uuid>.jsonl → 取末尾 uuid
export function codexSessionId(p: string): string {
  const b = path.basename(p, ".jsonl");
  const m = b.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : b;
}

// 按正文判 claude / codex / openclaw（用于任意目录 / 单文件输入，不靠路径）
export function detectFormat(text: string): "claude" | "codex" | "openclaw" {
  const head = text.slice(0, 4000);
  if (/"type"\s*:\s*"(response_item|session_meta|event_msg|turn_context)"/.test(head)) return "codex";
  // openclaw：trajectory trace schema，或 plain 日志特征（model_change /
  // thinking_level_change / parentId —— claude 都不产出，claude 用 parentUuid）。
  if (/"traceSchema"|"type"\s*:\s*"(session\.started|prompt\.submitted|model\.completed|context\.compiled|trace\.metadata)"/.test(head)
    || /"type"\s*:\s*"(model_change|thinking_level_change)"|"parentId"\s*:/.test(head)) return "openclaw";
  return "claude";
}

function fileMeta(p: string, mtimeMs: number): FileMeta {
  const c = fileMetaCache.get(p);
  if (c && c.mtimeMs === mtimeMs) return c;
  let lines = 0, text = "";
  try { text = fs.readFileSync(p, "utf8"); for (let i = 0; i < text.length; i++) if (text[i] === "\n") lines++; } catch {}
  const sm = structMeta(text);
  const meta: FileMeta = { mtimeMs, lines, cwd: sm.cwd, title: sm.title, format: detectFormat(text) };
  fileMetaCache.set(p, meta);
  return meta;
}

// 收集所有输入源下的 .jsonl（目录 → 递归；单文件 → 直接纳入），去重
function collectFiles(): string[] {
  const files: string[] = [];
  for (const r of allInputs()) {
    let st: fs.Stats; try { st = fs.statSync(r); } catch { continue; }
    if (st.isDirectory()) walk(r, files);
    else if (st.isFile() && r.endsWith(".jsonl")) files.push(r);
  }
  const uniq = [...new Set(files)];
  // OpenClaw 同一会话常有 `<id>.jsonl` + `<id>.trajectory.jsonl` 两份：plain 是完整
  // 实时日志，trajectory 是截断快照——有 plain 兄弟时丢弃 trajectory，避免重复列。
  const set = new Set(uniq);
  return uniq.filter((f) => {
    if (f.endsWith(".trajectory.jsonl")) {
      const plain = f.slice(0, -".trajectory.jsonl".length) + ".jsonl";
      if (set.has(plain)) return false;
    }
    return true;
  });
}

export function scanSessions(): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const f of collectFiles()) {
    let st: fs.Stats; try { st = fs.statSync(f); } catch { continue; }
    const meta = fileMeta(f, st.mtimeMs);
    // 已知默认源按路径定 agent；额外输入源按正文检测
    const agent = f.startsWith(CODEX_ROOT) ? "codex"
      : f.startsWith(OC_ROOT) ? "openclaw"
      : f.startsWith(CLAUDE_ROOT) ? "claude"
      : (meta.format || "claude");
    const isCodex = agent === "codex";
    rows.push({
      mtime: st.mtimeMs,
      mtimeStr: new Date(st.mtimeMs).toLocaleString("sv-SE").slice(0, 19),
      size: st.size,
      lines: meta.lines,
      agent,
      sessionId: isCodex ? codexSessionId(f) : path.basename(f, ".jsonl"),
      title: meta.title,
      cwd: meta.cwd,
      path: f,
    });
  }
  // hermes 会话来自 SQLite state.db（非 walk 的 .jsonl），单独并入。
  for (const r of listHermesSessions()) rows.push(r);
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}
