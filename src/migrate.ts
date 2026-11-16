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

export interface ManifestOp {
  agent: string;
  path: string;
  movedTo: string | null;
  changes: Change[];
  backup: string | null;
  postHash?: string;
  status: "done" | "failed";
  error: string | null;
}

export interface Manifest {
  id: string;
  // "project" | "account" 为迁移批次；"rollback" 为回滚前的安全备份批次（带 rollbackOf）。
  type: string;
  createdAt: string;
  ops: ManifestOp[];
  rollbackOf?: string;
}

export interface BatchSummary {
  id: string;
  type: string;
  createdAt: string;
  opCount: number;
  doneCount: number;
}

// 与现有 ~/.claude/projects 目录编码一致："/Users/me/proj" → "-Users-me-proj"
export function encodeClaudeProject(cwd: string): string {
  return cwd.split("/").join("-");
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// failed 项也要尽量回填 postHash：按候选路径找第一个仍存在的普通文件算 sha256；
// 无文件场景（hermes 合成引用 / target 不存在）返回 undefined，由调用方在 error 中说明。
function tryPostHash(...candidates: string[]): string | undefined {
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return sha256File(p);
    } catch {}
  }
  return undefined;
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
  // Hermes 合成引用（state.db 内的虚拟路径），磁盘上无文件，不触碰。
  if (abs.includes("::")) return { target: abs, real: abs, ok: false, error: "hermes synthetic ref is not migratable; postHash omitted: no backing file on disk", backupRel: null };
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return { target: abs, real: abs, ok: false, error: "target does not exist; postHash omitted: no backing file on disk", backupRel: null }; }
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

// codex 账号迁移：仅首条 session_meta 的 payload.creator_account_id / payload.creator_user_id，
// 内嵌祖先 meta 与其余字段一律不动。
function codexAccountMapper(value: string, userId: string, sink: Change[]): (rec: Rec) => Rec | null {
  let done = false;
  return (rec: Rec): Rec | null => {
    if (done || rec.type !== "session_meta" || !rec.payload) return null;
    done = true;
    const oldAccount = typeof rec.payload.creator_account_id === "string" ? rec.payload.creator_account_id : "";
    const oldUser = typeof rec.payload.creator_user_id === "string" ? rec.payload.creator_user_id : "";
    sink.push({ field: "payload.creator_account_id", from: oldAccount, to: value });
    sink.push({ field: "payload.creator_user_id", from: oldUser, to: userId });
    const payload: Rec = { ...rec.payload, creator_account_id: value, creator_user_id: userId };
    return { ...rec, payload };
  };
}

// 字节级原子覆盖：与 rewriteJsonlAtomic 同一套「同目录临时文件 → fsync → rename」纪律，
// 用于回滚时按备份原样还原（不能走 JSONL 重序列化，要求字节一致）。
function atomicCopyFile(src: string, dest: string): void {
  const tmp = path.join(path.dirname(dest), `.migrate-${crypto.randomBytes(8).toString("hex")}`);
  try {
    fs.copyFileSync(src, tmp);
    const fd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// 单项执行回调：返回 movedTo 表示该文件被挪到新路径，undefined 表示原地改写。
type ExecuteFn = (item: Prepared, changes: Change[]) => string | undefined;

// 批次通用骨架：先逐项校验+备份，再逐项执行，单项失败不拖垮批次，最后落 manifest。
function runBatch(targets: string[], opts: MigrateOpts, execute: ExecuteFn): MigrateResult {
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
      // I1：文件仍在磁盘上的 failed 项（越界 / 非 .jsonl / 备份异常等）回填 postHash。
      const postHash = tryPostHash(item.real, item.target);
      results.push({ path: item.target, status: "failed", error: item.error, changes, ...(postHash ? { postHash } : {}) });
      manifestOps.push({ agent: opts.agent, path: item.target, movedTo: null, changes, backup: item.backupRel, ...(postHash ? { postHash } : {}), status: "failed", error: item.error ?? null });
      continue;
    }
    try {
      const movedTo = execute(item, changes);
      const postFile = movedTo ?? item.real;
      const postHash = sha256File(postFile);
      results.push({ path: item.target, status: "done", ...(movedTo ? { movedTo } : {}), changes, postHash });
      manifestOps.push({ agent: opts.agent, path: item.target, movedTo: movedTo ?? null, changes, backup: item.backupRel, postHash, status: "done", error: null });
    } catch (e) {
      const error = (e as Error).message;
      // I1：执行期 failed 同样回填操作后文件的 sha256。源文件仍在时以源为准；
      // 源已移除（link+unlink 成功后改写失败）才取 dest。
      const destGuess = opts.agent === "claude"
        ? path.join(opts.claudeRoot, encodeClaudeProject(opts.value), path.basename(item.real))
        : item.real;
      const postHash = tryPostHash(item.real, destGuess, item.target);
      results.push({ path: item.target, status: "failed", error, changes, ...(postHash ? { postHash } : {}) });
      manifestOps.push({ agent: opts.agent, path: item.target, movedTo: null, changes, backup: item.backupRel, ...(postHash ? { postHash } : {}), status: "failed", error });
    }
  }

  const manifest: Manifest = {
    id: batchId,
    type: opts.type,
    createdAt: new Date().toISOString(),
    ops: manifestOps,
  };
  fs.writeFileSync(path.join(batchDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return { batchId, results };
}

// 工程迁移的单项执行：claude 先非覆盖移动再改写，codex/openclaw 原地改写。
function executeProject(opts: MigrateOpts): ExecuteFn {
  return (item, changes) => {
    if (opts.agent === "claude") {
      const destDir = path.join(opts.claudeRoot, encodeClaudeProject(opts.value));
      const dest = path.join(destDir, path.basename(item.real));
      fs.mkdirSync(destDir, { recursive: true });
      // existsSync 只用于生成可读错误；真正的「绝不覆盖」不变量由 linkSync 的原子 EEXIST 保证（消除 TOCTOU）。
      if (fs.existsSync(dest)) throw new Error(`destination already exists: ${dest}`);
      try {
        // 先移动后改写：link 不修改源文件，失败时源文件完全未触碰。
        fs.linkSync(item.real, dest);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code || (e as Error).message;
        throw new Error(`non-overwriting move failed (${code}): ${dest}`);
      }
      try {
        fs.unlinkSync(item.real);
      } catch (e) {
        // 边角：link 成功但 unlink 失败 → 两份副本都在。不得继续改写 dest，保留现场报 failed。
        throw new Error(`linked destination but failed to remove source, both copies kept: ${(e as Error).message}`);
      }
      rewriteJsonlAtomic(dest, claudeProjectMapper(opts.value, changes), changes);
      return dest;
    }
    if (opts.agent === "codex") {
      rewriteJsonlAtomic(item.real, codexProjectMapper(opts.value, changes), changes);
      return undefined;
    }
    rewriteJsonlAtomic(item.real, openclawProjectMapper(opts.value, changes), changes);
    return undefined;
  };
}

// 账号迁移的单项执行：仅 codex，原地改写首条 session_meta 的两个 creator 字段。
function executeAccount(opts: MigrateOpts): ExecuteFn {
  return (item, changes) => {
    if (opts.agent !== "codex") {
      throw new Error(`account migration is only supported for codex sessions; agent "${opts.agent}" is not supported`);
    }
    if (!opts.userId) {
      // 失败发生在任何改写之前：prepare 阶段只做了备份，目标文件保持字节一致。
      throw new Error("account migration requires a non-empty opts.userId (creator_user_id)");
    }
    rewriteJsonlAtomic(item.real, codexAccountMapper(opts.value, opts.userId, changes), changes);
    return undefined;
  };
}

export function migrateSessions(targets: string[], opts: MigrateOpts): MigrateResult {
  if (opts.type !== "project" && opts.type !== "account") {
    throw new Error(`unknown migration type: ${opts.type}`);
  }
  if (!opts.value) {
    throw new Error(opts.type === "project"
      ? "migration value must be a non-empty absolute path"
      : "account migration value (creator_account_id) must be a non-empty string");
  }
  if (opts.type === "project" && !path.isAbsolute(opts.value)) {
    throw new Error("migration value must be a non-empty absolute path");
  }
  const value = opts.type === "project" ? path.resolve(opts.value) : opts.value;
  const normalized: MigrateOpts = { ...opts, value };

  const execute = opts.type === "project" ? executeProject(normalized) : executeAccount(normalized);
  return runBatch(targets, normalized, execute);
}

// ---- 批次查询 ----

// 批次 id 只允许时间戳 id 的字符集：拒绝任何分隔符与 ".."，basename 等值校验兜底路径穿越。
function validateBatchId(batchId: string): void {
  if (typeof batchId !== "string" || batchId === "" || batchId.includes("..") || /[\\/]/.test(batchId) || batchId !== path.basename(batchId)) {
    throw new Error(`invalid batch id: ${JSON.stringify(batchId)}`);
  }
}

export function readBatch(batchId: string, backupRoot: string): Manifest {
  validateBatchId(batchId);
  const manifestPath = path.join(backupRoot, batchId, "manifest.json");
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (e) {
    throw new Error(`batch manifest not found for ${batchId}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as Manifest;
  } catch (e) {
    throw new Error(`batch manifest unreadable for ${batchId}: ${(e as Error).message}`);
  }
}

// 列 backupRoot 下全部带合法 manifest 的子目录（含 rollback-* 安全备份），按时间倒序；
// 无 manifest / 不可读的子目录与普通文件一律跳过，不抛错。
export function listBatches(backupRoot: string): BatchSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: BatchSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let manifest: Manifest;
    try {
      manifest = readBatch(entry.name, backupRoot);
    } catch {
      continue;
    }
    summaries.push({
      id: manifest.id,
      type: manifest.type,
      createdAt: manifest.createdAt,
      opCount: manifest.ops.length,
      doneCount: manifest.ops.filter((op) => op.status === "done").length,
    });
  }
  // createdAt 为 ISO 字符串可直接字典序比较；同刻内以 id 倒序兜底。
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return summaries;
}

// ---- 漂移检测回滚 ----

export function rollbackBatch(batchId: string, backupRoot: string): MigrateResult {
  const manifest = readBatch(batchId, backupRoot);
  // 控制器裁定：failed op 只留记录，回滚/漂移逻辑只处理 status:"done" 项。
  const doneOps = manifest.ops.filter((op) => op.status === "done");

  // ① 漂移检测：当前文件（有 movedTo 取 movedTo，否则 path）sha256 对 postHash。
  // 任一不匹配或 backing file 缺失 → 整批中止，不做任何还原，也不创建 rollback 目录。
  const conflicts = new Map<ManifestOp, string>();
  for (const op of doneOps) {
    const current = op.movedTo ?? op.path;
    let st: fs.Stats;
    try {
      st = fs.statSync(current);
    } catch {
      conflicts.set(op, `drift conflict: backing file missing: ${current}`);
      continue;
    }
    if (!st.isFile()) {
      conflicts.set(op, `drift conflict: backing path is not a regular file: ${current}`);
      continue;
    }
    const hash = sha256File(current);
    if (hash !== op.postHash) {
      conflicts.set(op, `drift conflict: sha256 mismatch (current=${hash}, postHash=${op.postHash ?? ""}): ${current}`);
    }
  }

  if (conflicts.size > 0) {
    const results: OpResult[] = doneOps.map((op) => {
      const conflict = conflicts.get(op);
      return conflict
        ? { path: op.path, status: "failed", error: conflict, changes: [] }
        : { path: op.path, status: "failed", error: `rollback aborted: drift conflict detected in batch ${batchId}; no restore was performed`, changes: [] };
    });
    return { batchId, results };
  }

  // ② 全部通过后先做安全备份：rollback-<batchId>/，同结构 + 自己的 manifest。
  const rollbackId = `rollback-${batchId}`;
  const rollbackDir = path.join(backupRoot, rollbackId);
  fs.mkdirSync(rollbackDir, { recursive: true });

  const rollbackOps: ManifestOp[] = [];
  const results: OpResult[] = [];

  const recordFailure = (op: ManifestOp, error: string): void => {
    const postHash = tryPostHash(op.movedTo ?? op.path, op.path);
    results.push({ path: op.path, status: "failed", error, changes: [], ...(postHash ? { postHash } : {}) });
    rollbackOps.push({ agent: op.agent, path: op.path, movedTo: null, changes: [], backup: op.backup, ...(postHash ? { postHash } : {}), status: "failed", error });
  };

  const recordDone = (op: ManifestOp, finalPath: string): void => {
    const postHash = sha256File(finalPath);
    results.push({ path: op.path, status: "done", changes: [], postHash });
    rollbackOps.push({ agent: op.agent, path: op.path, movedTo: null, changes: [], backup: op.backup, postHash, status: "done", error: null });
  };

  // 安全备份在任何还原动作之前捕获当前文件（漂移检测已保证其等于 postHash 状态）。
  for (const op of doneOps) {
    const current = op.movedTo ?? op.path;
    if (!op.backup) {
      recordFailure(op, `cannot rollback: manifest op has no backup copy: ${op.path}`);
      continue;
    }
    try {
      const safetyCopy = path.join(rollbackDir, op.backup);
      fs.mkdirSync(path.dirname(safetyCopy), { recursive: true });
      fs.copyFileSync(current, safetyCopy);
    } catch (e) {
      recordFailure(op, `safety backup failed: ${(e as Error).message}`);
    }
  }

  // ③ 反向执行：移动过的先 link 回原路径（原路径占用即失败、绝不覆盖）再用备份覆盖；
  // 原地项直接按备份字节级原子覆盖。单项失败不拖垮其余项。
  const movedOps = doneOps.filter((op) => op.movedTo);
  const inPlaceOps = doneOps.filter((op) => !op.movedTo);

  for (const op of movedOps) {
    if (!op.backup || results.some((r) => r.path === op.path && r.status === "failed")) continue;
    try {
      if (fs.existsSync(op.path)) throw new Error(`original path already occupied, refuse to overwrite: ${op.path}`);
      try {
        fs.linkSync(op.movedTo as string, op.path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code || (e as Error).message;
        throw new Error(`non-overwriting move-back failed (${code}): ${op.path}`);
      }
      try {
        fs.unlinkSync(op.movedTo as string);
      } catch (e) {
        throw new Error(`linked original path but failed to remove moved file, both copies kept: ${(e as Error).message}`);
      }
      atomicCopyFile(path.join(backupRoot, batchId, op.backup), op.path);
      recordDone(op, op.path);
    } catch (e) {
      recordFailure(op, (e as Error).message);
    }
  }

  for (const op of inPlaceOps) {
    if (!op.backup || results.some((r) => r.path === op.path && r.status === "failed")) continue;
    try {
      atomicCopyFile(path.join(backupRoot, batchId, op.backup), op.path);
      recordDone(op, op.path);
    } catch (e) {
      recordFailure(op, (e as Error).message);
    }
  }

  const rollbackManifest: Manifest = {
    id: rollbackId,
    type: "rollback",
    createdAt: new Date().toISOString(),
    ops: rollbackOps,
    rollbackOf: batchId,
  };
  fs.writeFileSync(path.join(rollbackDir, "manifest.json"), JSON.stringify(rollbackManifest, null, 2) + "\n");

  return { batchId: rollbackId, results };
}
