// migrate.ts — 会话工程迁移：备份、JSONL 定点改写、原子落盘、批次 manifest
// 设计约束见 docs/superpowers/specs/2026-11-16-account-project-migration-design.md 5.3/5.4：
// 只改归属元数据（首个 cwd / 首条 session_meta），逐轮历史 cwd 一律保留；先备份后执行；单项失败不拖垮批次。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Rec } from "./types.ts";

export type Change = { field: string; from: string; to: string };

export type OpResult = {
  path: string;
  status: "done" | "failed";
  error?: string;
  movedTo?: string;
  changes: Change[];
  postHash?: string;
};

export interface MigrateOpts {
  type: "project" | "account";
  value: string;
  userId?: string;
  allowedRoots: string[];
  claudeRoot: string;
  backupRoot: string;
  agent: "claude" | "codex" | "openclaw";
}

export interface MigrateResult {
  batchId: string;
  results: OpResult[];
}

interface ManifestOp {
  agent: string;
  path: string;
  movedTo: string | null;
  changes: Change[];
  backup: string | null;
  postHash?: string;
  status: "done" | "failed";
  error: string | null;
}

// 与现有 ~/.claude/projects 目录编码一致："/Users/me/proj" → "-Users-me-proj"
export function encodeClaudeProject(cwd: string): string {
  return cwd.split("/").join("-");
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// 逐行改写 JSONL 并原子覆盖。
// - mapRecord 返回 null 表示该行不改（原始字符串原样回写，不做重新序列化）；
// - JSON.parse 失败的行保留原始字符串并计数，绝不丢行；
// - 临时文件写在同目录（.migrate-<随机>），fsync 后 rename 覆盖；输出每行一个 JSON、末尾 \n。
// sink 可选：调用方用它收集结构化 Change（mapper 闭包内 push）。
export function rewriteJsonlAtomic(
  file: string,
  mapRecord: (rec: Rec, idx: number) => Rec | null,
  sink: Change[] = [],
): { changed: boolean; changes: Change[] } {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();

  let changed = false;
  let badLines = 0; // 损坏行计数：只统计与逐字保留，绝不丢行
  let recIdx = 0;
  const out: string[] = [];
  for (const raw of lines) {
    if (raw.trim() === "") { out.push(raw); continue; }
    let rec: Rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      badLines += 1;
      out.push(raw); // 损坏行逐字保留（含可能的 \r）
      continue;
    }
    const mapped = mapRecord(rec, recIdx++);
    if (mapped === null) { out.push(raw); continue; }
    changed = true;
    out.push(JSON.stringify(mapped));
  }
  if (!changed) return { changed: false, changes: sink };

  const tmp = path.join(path.dirname(file), `.migrate-${crypto.randomBytes(8).toString("hex")}`);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, out.join("\n") + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return { changed: true, changes: sink };
}

function timestampId(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

// 校验 + 备份阶段的单项状态
interface Prepared {
  target: string;
  real: string;
  ok: boolean;
  error?: string;
  backupRel: string | null;
}

function prepareTarget(target: string, allowedRoots: string[], batchDir: string): Prepared {
  const abs = path.resolve(target);
  // Hermes 合成引用（state.db 内的虚拟路径），不触碰。
  if (abs.includes("::")) return { target: abs, real: abs, ok: false, error: "hermes synthetic ref is not migratable", backupRel: null };
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return { target: abs, real: abs, ok: false, error: "target does not exist", backupRel: null }; }
  if (!st.isFile() || !abs.endsWith(".jsonl")) {
    return { target: abs, real: abs, ok: false, error: "target must be an existing .jsonl regular file", backupRel: null };
  }
  let real = abs;
  try { real = fs.realpathSync(abs); } catch {}
  const rootReals = allowedRoots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  const inRoot = rootReals.some((r) => real === r || real.startsWith(r + path.sep));
  if (!inRoot) return { target: abs, real, ok: false, error: "resolved path is outside allowedRoots", backupRel: null };

  // 备份在任何改写/移动之前完成：按去掉前导 / 的绝对路径存放。
  const backupRel = real.replace(/^\//, "");
  const backupPath = path.join(batchDir, backupRel);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(real, backupPath);
  return { target: abs, real, ok: true, backupRel };
}

// claude：第一条含字符串 cwd 的记录（归属记录）替换；后续逐轮 cwd 不动。
function claudeProjectMapper(value: string, sink: Change[]): (rec: Rec) => Rec | null {
  let done = false;
  return (rec: Rec): Rec | null => {
    if (done || typeof rec.cwd !== "string") return null;
    done = true;
    const from = rec.cwd;
    sink.push({ field: "cwd", from, to: value });
    return { ...rec, cwd: value };
  };
}

// codex：仅首条 session_meta 的 payload.cwd 与 runtime_workspace_roots 中等于旧 cwd 的元素。
function codexProjectMapper(value: string, sink: Change[]): (rec: Rec) => Rec | null {
  let done = false;
  return (rec: Rec): Rec | null => {
    if (done || rec.type !== "session_meta" || !rec.payload || typeof rec.payload.cwd !== "string") return null;
    done = true;
    const old = rec.payload.cwd;
    const payload: Rec = { ...rec.payload, cwd: value };
    sink.push({ field: "payload.cwd", from: old, to: value });
    if (Array.isArray(payload.runtime_workspace_roots)) {
      payload.runtime_workspace_roots = payload.runtime_workspace_roots.map((root: unknown) => {
        if (root === old) { sink.push({ field: "payload.runtime_workspace_roots", from: old, to: value }); return value; }
        return root;
      });
    }
    return { ...rec, payload };
  };
}

// openclaw：第一条含顶层字符串 cwd 的记录替换。
function openclawProjectMapper(value: string, sink: Change[]): (rec: Rec) => Rec | null {
  let done = false;
  return (rec: Rec): Rec | null => {
    if (done || typeof rec.cwd !== "string") return null;
    done = true;
    const from = rec.cwd;
    sink.push({ field: "cwd", from, to: value });
    return { ...rec, cwd: value };
  };
}

export function migrateSessions(targets: string[], opts: MigrateOpts): MigrateResult {
  if (opts.type === "account") throw new Error("not implemented");
  if (opts.type !== "project") throw new Error(`unknown migration type: ${opts.type}`);
  if (!opts.value || !path.isAbsolute(opts.value)) throw new Error("migration value must be a non-empty absolute path");
  const value = path.resolve(opts.value);

  const batchId = timestampId();
  const batchDir = path.join(opts.backupRoot, batchId);
  fs.mkdirSync(batchDir, { recursive: true });

  // 阶段一：先逐项校验并备份全部目标。
  const prepared = targets.map((t) => {
    try {
      return prepareTarget(t, opts.allowedRoots, batchDir);
    } catch (e) {
      return { target: path.resolve(t), real: path.resolve(t), ok: false, error: (e as Error).message, backupRel: null } satisfies Prepared;
    }
  });

  // 阶段二：逐项执行，单项失败不影响其余。
  const results: OpResult[] = [];
  const manifestOps: ManifestOp[] = [];

  for (const item of prepared) {
    const changes: Change[] = [];
    if (!item.ok) {
      results.push({ path: item.target, status: "failed", error: item.error, changes });
      manifestOps.push({ agent: opts.agent, path: item.target, movedTo: null, changes, backup: item.backupRel, status: "failed", error: item.error ?? null });
      continue;
    }
    try {
      let movedTo: string | undefined;
      if (opts.agent === "claude") {
        const destDir = path.join(opts.claudeRoot, encodeClaudeProject(value));
        const dest = path.join(destDir, path.basename(item.real));
        // 同名已存在：绝不覆盖，且在任何改写之前中止。
        if (fs.existsSync(dest)) throw new Error(`destination already exists: ${dest}`);
        rewriteJsonlAtomic(item.real, claudeProjectMapper(value, changes), changes);
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(item.real, dest);
        movedTo = dest;
      } else if (opts.agent === "codex") {
        rewriteJsonlAtomic(item.real, codexProjectMapper(value, changes), changes);
      } else {
        rewriteJsonlAtomic(item.real, openclawProjectMapper(value, changes), changes);
      }
      const postFile = movedTo ?? item.real;
      const postHash = sha256File(postFile);
      results.push({ path: item.target, status: "done", movedTo, changes, postHash });
      manifestOps.push({ agent: opts.agent, path: item.target, movedTo: movedTo ?? null, changes, backup: item.backupRel, postHash, status: "done", error: null });
    } catch (e) {
      const error = (e as Error).message;
      results.push({ path: item.target, status: "failed", error, changes });
      manifestOps.push({ agent: opts.agent, path: item.target, movedTo: null, changes, backup: item.backupRel, status: "failed", error });
    }
  }

  const manifest = {
    id: batchId,
    type: opts.type,
    createdAt: new Date().toISOString(),
    ops: manifestOps,
  };
  fs.writeFileSync(path.join(batchDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return { batchId, results };
}
