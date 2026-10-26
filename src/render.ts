// render.ts — /api/render 入口：路径安全校验 + 结果缓存 + claude/codex 格式分发
import fs from "node:fs";
import path from "node:path";
import { CODEX_ROOT, OC_ROOT, allInputs } from "./config.ts";
import { detectFormat } from "./scan.ts";
import { renderClaude } from "./parse-claude.ts";
import { renderCodex } from "./parse-codex.ts";
import { renderOpenclaw } from "./parse-openclaw.ts";
import { isHermesRef, renderHermes } from "./parse-hermes.ts";
import type { RenderError, RenderResult } from "./types.ts";

// 按 path 缓存最近解析结果；mtime 不变则直接命中，重开同一 trace 免去整文件重解析。
const renderCache = new Map<string, { mtimeMs: number; result: RenderResult }>();
const MAX_CACHE = 32;

// 只允许读取输入源根目录下、以 .jsonl 结尾的文件。
export function renderTranscript(p: string): RenderResult | RenderError {
  // hermes 会话不是文件，而是 state.db 里的一行，ref 形如 `<db>::<sessionId>`。
  // 走 SQLite 解析，绕过下面的 .jsonl 路径校验（renderHermes 只读固定的 HERMES_DB）。
  if (isHermesRef(p)) return renderHermes(p);

  const real = path.resolve(p);
  const allowed = real.endsWith(".jsonl") && allInputs().some((r) => real === r || real.startsWith(r + path.sep));
  if (!allowed) return { error: "path not allowed" };

  let st: fs.Stats;
  try { st = fs.statSync(real); } catch (e) { return { error: String(e) }; }

  const cached = renderCache.get(real);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    // 命中即视为最近使用：重排到末尾，淘汰真正最久未用的项。
    renderCache.delete(real); renderCache.set(real, cached);
    return cached.result;
  }

  let text: string;
  try { text = fs.readFileSync(real, "utf8"); } catch (e) { return { error: String(e) }; }
  const result =
    (real.startsWith(OC_ROOT) || detectFormat(text) === "openclaw") ? renderOpenclaw(real, text)
    : (real.startsWith(CODEX_ROOT) || detectFormat(text) === "codex") ? renderCodex(real, text)
    : renderClaude(real, text);

  renderCache.set(real, { mtimeMs: st.mtimeMs, result });
  if (renderCache.size > MAX_CACHE) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return result;
}
