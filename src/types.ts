// types.ts — 统一 trace 数据模型（claude / codex 解析后的产物，供前端消费）

export type Role = "user" | "assistant" | "system" | "developer" | "tool";

export interface Block {
  kind: string; // text | thinking | tool_use | tool_result | image | <其它原样透传>
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  ok?: boolean;
  toolName?: string;
}

export interface Injection {
  itype: string;
  hookName: string;
  hookEvent?: string;
  meta: string;
  text: string;
  trivial: boolean;
}

export interface TraceEvent {
  seq: number;
  role: Role;
  ts: string;
  blocks?: Block[];
  inj?: Injection;
  model?: string;
  usage?: unknown;
}

export interface RenderResult {
  path: string;
  cwd: string;
  sessionId: string;
  title: string;
  count: number;
  events: TraceEvent[];
  // 账户归属：codex 取首条 session_meta 的 creator_account_id（parser 落 id，
  // label 由 render 层按三分支规则贴）；claude 取本机共享身份；openclaw/hermes 留空。
  accountId?: string;
  accountLabel?: string;
}

export interface RenderError {
  error: string;
}

export interface SessionRow {
  mtime: number;
  mtimeStr: string;
  size: number;
  lines: number;
  agent: string;
  sessionId: string;
  title: string;
  cwd: string;
  path: string;
  // 账户归属：codex 取首条 session_meta 的 creator_account_id；claude 取本机共享身份。
  // openclaw / hermes 无账户概念，保持 undefined。
  accountId?: string;
  accountLabel?: string;
}

export interface StructMeta {
  cwd: string;
  title: string;
  // 仅 codex：首条 session_meta.payload 的 creator 字段；后续内嵌 meta 一律忽略。
  accountId?: string;
  accountUserId?: string;
}

export interface AddResult {
  ok: boolean;
  error?: string;
}

// jsonl 一行解析出的任意记录；字段形态因 agent 而异，按需收窄。
export type Rec = Record<string, any>;
