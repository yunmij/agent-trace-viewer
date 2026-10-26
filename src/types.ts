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
}

export interface StructMeta {
  cwd: string;
  title: string;
}

export interface AddResult {
  ok: boolean;
  error?: string;
}

// jsonl 一行解析出的任意记录；字段形态因 agent 而异，按需收窄。
export type Rec = Record<string, any>;
