// render.ts — /api/render 入口：路径安全校验 + 结果缓存 + claude/codex 格式分发
import fs from "node:fs";
import path from "node:path";
import { CODEX_ROOT, OC_ROOT, allInputs } from "./config.ts";
import { detectFormat, codexAccountLabel } from "./scan.ts";
import { renderClaude } from "./parse-claude.ts";
import { renderCodex } from "./parse-codex.ts";
import { renderOpenclaw } from "./parse-openclaw.ts";
import { isHermesRef, renderHermes } from "./parse-hermes.ts";
import { getClaudeIdentity, getCodexAuthIdentity, readAccountNotes } from "./identity.ts";
import type { RenderError, RenderResult } from "./types.ts";

// 按 path 缓存最近解析结果；mtime 不变则直接命中，重开同一 trace 免去整文件重解析。
// 缓存只存文件派生数据（codex 的 accountId 来自文件内容）；账户 label 在缓存外每次重贴，
// 这样新增/修改备注后无需等文件 mtime 变化即可在详情页看到新标签。
const renderCache = new Map<string, { mtimeMs: number; kind: RenderKind; result: RenderResult }>();
const MAX_CACHE = 32;

type RenderKind = "claude" | "codex" | "openclaw";

// 控制器裁定（Task 6）：独立 trace 页只拿到 path，禁止反查 /api/sessions 触发全量重扫。
// 账户标签在 render 层后处理贴附，规则与 scan.ts 完全一致：
//   claude   → 本机共享身份（读不到凭据则两字段留空）
//   codex    → 当前登录邮箱 → 账户备注 → account-<id 前 8 位> 三分支
//   openclaw → 无账户概念，留空（hermes 在调用方提前分流，不进此函数）
export function attachAccount(base: RenderResult, kind: RenderKind): RenderResult {
  if (kind === "claude") {
    const identity = getClaudeIdentity();
    return identity ? { ...base, accountId: identity.id, accountLabel: identity.label } : base;
  }
  if (kind === "codex" && base.accountId) {
    const label = codexAccountLabel(base.accountId, readAccountNotes(), getCodexAuthIdentity());
    return { ...base, accountLabel: label };
  }
  return base;
}

// 会话主模型：events 里首个带 model 的事件。四个 parser 都已把模型解析到 TraceEvent.model，
// 这里统一后处理即可，parser 与缓存结构不用改；hermes 走同一入口（见 renderTranscript 末尾）。
export function attachModel(base: RenderResult): RenderResult {
  if (base.model) return base;
  const first = base.events.find((e) => typeof e.model === "string" && e.model);
  return first?.model ? { ...base, model: first.model } : base;
}

// 只允许读取输入源根目录下、以 .jsonl 结尾的文件。
export function renderTranscript(p: string): RenderResult | RenderError {
  // hermes 会话不是文件，而是 state.db 里的一行，ref 形如 `<db>::<sessionId>`。
  // 走 SQLite 解析，绕过下面的 .jsonl 路径校验（renderHermes 只读固定的 HERMES_DB）。
  // hermes 无账户概念，不做账户贴附，但模型同样经 attachModel 统一补齐。
  if (isHermesRef(p)) return attachModel(renderHermes(p));

  const real = path.resolve(p);
  const allowed = real.endsWith(".jsonl") && allInputs().some((r) => real === r || real.startsWith(r + path.sep));
  if (!allowed) return { error: "path not allowed" };

  let st: fs.Stats;
  try { st = fs.statSync(real); } catch (e) { return { error: String(e) }; }

  // trace 视图需要整文件解析后渲染进 DOM，GB 级 jsonl 既会撞 V8 单字符串上限也无法在页面内使用。
  // 列表元数据与迁移已走分块路径不受此限；这里给明确错误而非裸 RangeError。
  const MAX_RENDER_BYTES = 400 * 1024 * 1024;
  if (st.size > MAX_RENDER_BYTES) {
    return { error: `session file is too large to render in full (${(st.size / 1e9).toFixed(2)} GB); metadata and migration remain available, but the trace view is capped at 400 MB` };
  }

  const cached = renderCache.get(real);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    // 命中即视为最近使用：重排到末尾，淘汰真正最久未用的项。
    renderCache.delete(real); renderCache.set(real, cached);
    return attachModel(attachAccount(cached.result, cached.kind));
  }

  let text: string;
  try { text = fs.readFileSync(real, "utf8"); } catch (e) { return { error: String(e) }; }
  const kind: RenderKind =
    (real.startsWith(OC_ROOT) || detectFormat(text) === "openclaw") ? "openclaw"
    : (real.startsWith(CODEX_ROOT) || detectFormat(text) === "codex") ? "codex"
    : "claude";
  const base =
    kind === "openclaw" ? renderOpenclaw(real, text)
    : kind === "codex" ? renderCodex(real, text)
    : renderClaude(real, text);

  renderCache.set(real, { mtimeMs: st.mtimeMs, kind, result: base });
  if (renderCache.size > MAX_CACHE) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return attachModel(attachAccount(base, kind));
}
