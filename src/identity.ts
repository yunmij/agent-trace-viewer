// identity.ts — 本机账户身份读取：Claude 订阅凭据、Codex 登录态 JWT、账户备注持久化
// 设计约定：文件读取/JSON 解析一律静默降级（null 或空对象），只有 decodeJwtPayload 对畸形 token 抛异常。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AccountInfo {
  kind: "claude" | "codex";
  id: string;
  label: string;
  email?: string;
}

// 读文件并解析 JSON；任何失败（缺文件、权限、非法 JSON）统一返回 null，调用方自行降级。
function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 纯函数解 JWT payload（base64url），不验签；段数不为 3 时抛 invalid jwt。
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

// Claude 身份：~/.claude/.credentials.json 取订阅类型，~/.claude.json 取 userID。
// label = `${subscriptionType} · ${userID 前 8 位}`，id = userID 前 8 位。
export function getClaudeIdentity(homeDir: string = os.homedir()): AccountInfo | null {
  const creds = readJson(path.join(homeDir, ".claude", ".credentials.json")) as
    | { claudeAiOauth?: { subscriptionType?: unknown } }
    | null;
  const root = readJson(path.join(homeDir, ".claude.json")) as { userID?: unknown } | null;
  const subscriptionType = creds?.claudeAiOauth?.subscriptionType;
  const userID = root?.userID;
  if (typeof subscriptionType !== "string" || typeof userID !== "string" || userID.length < 8) return null;
  const shortId = userID.slice(0, 8);
  return { kind: "claude", id: shortId, label: `${subscriptionType} · ${shortId}` };
}

// Codex 身份：~/.codex/auth.json 的 tokens.id_token 解 payload，取 email 与 chatgpt_account_id。
export function getCodexAuthIdentity(homeDir: string = os.homedir()): AccountInfo | null {
  const auth = readJson(path.join(homeDir, ".codex", "auth.json")) as { tokens?: { id_token?: unknown } } | null;
  const token = auth?.tokens?.id_token;
  if (typeof token !== "string") return null;
  try {
    const payload = decodeJwtPayload(token);
    const { email, chatgpt_account_id: accountId } = payload;
    if (typeof accountId !== "string") return null;
    const info: AccountInfo = { kind: "codex", id: accountId, label: typeof email === "string" ? email : accountId };
    if (typeof email === "string") info.email = email;
    return info;
  } catch {
    return null;
  }
}

// 账户备注文件路径：~/.agent-trace-viewer/accounts.json
function accountsFile(homeDir: string): string {
  return path.join(homeDir, ".agent-trace-viewer", "accounts.json");
}

// 读备注；文件不存在或内容损坏时返回空 codex 表，不抛异常。
export function readAccountNotes(homeDir: string = os.homedir()): { codex: Record<string, string> } {
  const data = readJson(accountsFile(homeDir)) as { codex?: Record<string, string> } | null;
  if (!data || typeof data !== "object" || !data.codex || typeof data.codex !== "object") return { codex: {} };
  return { codex: data.codex };
}

// 写备注：先建目录，再与既有内容合并后两空格缩进写回。
export function saveAccountNote(accountId: string, label: string, homeDir: string = os.homedir()): void {
  const file = accountsFile(homeDir);
  const notes = readAccountNotes(homeDir);
  notes.codex[accountId] = label;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(notes, null, 2));
}
