// config.ts — 主机/默认数据源、运行时输入源管理、CLI 参数解析与帮助
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { AddResult } from "./types.ts";

// 监听地址：默认仅本机（会话内容可能含代码与密钥）；需要局域网访问时显式 --host 0.0.0.0。
// 用 let + live binding，server.ts 直接读到 parseArgs 里改后的值。
export let HOST = "127.0.0.1";

// 从模块位置向上找最近的 package.json，读 version（dev 跑 src/ 与安装后跑 dist/src/ 层级不同，故向上找）。
export function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const pj = path.join(dir, "package.json");
    try { return JSON.parse(fs.readFileSync(pj, "utf8")).version || "unknown"; } catch {}
    dir = path.dirname(dir);
  }
  return "unknown";
}
export const CLAUDE_ROOT = path.join(os.homedir(), ".claude", "projects");
export const OC_ROOT = path.join(os.homedir(), ".openclaw", "agents");
export const CODEX_ROOT = path.join(os.homedir(), ".codex", "sessions");
// hermes 不写 .jsonl，会话在 SQLite state.db。它不是 walk 目录，单独处理（见
// scan.ts / parse-hermes.ts），故不进 DEFAULT_ROOTS（那是 walk .jsonl 用的）。
export const HERMES_DB = path.join(os.homedir(), ".hermes", "state.db");
export const DEFAULT_ROOTS = [CLAUDE_ROOT, OC_ROOT, CODEX_ROOT];

// 额外输入源：可为「文件夹」或「单个 .jsonl 文件」。CLI --root 传入 + 运行时 /api/inputs 增删。默认源始终保留。
export const extraInputs: string[] = [];

export function addInput(p: string): AddResult {
  const real = path.resolve(p);
  let st: fs.Stats;
  try { st = fs.statSync(real); } catch { return { ok: false, error: "Path does not exist: " + real }; }
  if (st.isFile() && !real.endsWith(".jsonl")) return { ok: false, error: "File must end with .jsonl: " + real };
  if (!st.isFile() && !st.isDirectory()) return { ok: false, error: "Not a file or directory: " + real };
  if (!DEFAULT_ROOTS.includes(real) && !extraInputs.includes(real)) extraInputs.push(real);
  return { ok: true };
}
export function removeInput(p: string): void { const i = extraInputs.indexOf(path.resolve(p)); if (i >= 0) extraInputs.splice(i, 1); }
export function allInputs(): string[] { return [...DEFAULT_ROOTS, ...extraInputs]; }

export function printHelp(): void {
  console.log(`agent-trace-viewer — browse and visualize local AI agent session traces

Usage: agent-trace-viewer [--port <n>] [--host <addr>] [--root <dir|file.jsonl> ...]

  -p, --port <n>       Port to listen on (default 8787, env PORT)
      --host <addr>    Address to bind (default 127.0.0.1, env HOST).
                       ⚠️  --host 0.0.0.0 exposes every local session to your network.
      --root <path>    Extra input: a directory or a single .jsonl file. Repeatable.
  -v, --version        Print version
  -h, --help           Show this help

Default sources: ~/.claude/projects · ~/.codex/sessions · ~/.openclaw/agents · ~/.hermes/state.db
Extra sources can also be added at runtime from the "Input sources" panel.`);
}

// 解析 CLI 参数；--root 即时写入 extraInputs，返回最终 PORT。
export function parseArgs(argv: string[]): number {
  let port = Number(process.env.PORT || 0);
  if (process.env.HOST) HOST = process.env.HOST;
  // 取需要带值的参数的下一项；缺值（末尾或紧跟另一个 -flag）直接报错，避免赋成 undefined。
  const val = (i: number, name: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) { console.error(`${name} requires a value (see --help)`); process.exit(2); }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") port = Number(val(++i, a));
    else if (a === "--host") HOST = val(++i, a);
    else if (a === "--root" || a === "--input") { const r = addInput(val(++i, a)); if (!r.ok) console.error("⚠️  " + r.error); }
    else if (a === "-v" || a === "--version") { console.log(readVersion()); process.exit(0); }
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else { console.error("Unknown argument: " + a + " (see --help)"); process.exit(2); }
  }
  if (!port) port = 8787;
  return port;
}
