// migrate.test.ts — 工程迁移模块测试：mkdtemp 沙箱内造全套 fixture，无 mock、不碰真实会话目录
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  migrateSessions,
  rewriteJsonlAtomic,
  encodeClaudeProject,
  type MigrateOpts,
} from "../src/migrate.ts";

function sandbox(): { root: string; allowedRoot: string; claudeRoot: string; backupRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atv-migrate-"));
  const allowedRoot = path.join(root, "sessions");
  const claudeRoot = path.join(root, "claude-projects");
  const backupRoot = path.join(root, "backups");
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(claudeRoot, { recursive: true });
  return { root, allowedRoot, claudeRoot, backupRoot };
}

function writeJsonl(p: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function readJsonl(p: string): any[] {
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function baseOpts(partial: Partial<MigrateOpts> & Pick<MigrateOpts, "agent" | "value">): MigrateOpts {
  return {
    type: "project",
    allowedRoots: [partial.allowedRoots ?? ""],
    claudeRoot: partial.claudeRoot ?? "",
    backupRoot: partial.backupRoot ?? "",
    ...partial,
  } as MigrateOpts;
}

test("① claude 工程迁移：移动到编码目录且仅第一条 cwd 记录被改写", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  writeJsonl(src, [
    { cwd: "/old/proj", type: "summary", title: "t" },
    { cwd: "/old/proj", type: "user", message: "later turn" },
  ]);
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].status, "done", res.results[0].error);

  const dest = path.join(sb.claudeRoot, encodeClaudeProject("/new/proj"), "claude-session.jsonl");
  assert.ok(fs.existsSync(dest), "目标文件存在");
  assert.ok(!fs.existsSync(src), "原路径文件已消失");

  const recs = readJsonl(dest);
  assert.equal(recs[0].cwd, "/new/proj");
  assert.equal(recs[1].cwd, "/old/proj", "后续逐轮 cwd 必须保留旧值");
  assert.equal(res.results[0].movedTo, dest);
});

test("② codex：仅首条 session_meta 的 cwd 与 workspace_roots 被改，turn_context/内嵌 meta 不动", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "rollout-codex.jsonl");
  writeJsonl(src, [
    { type: "session_meta", payload: { cwd: "/old/proj", runtime_workspace_roots: ["/old/proj", "/other/lib"] } },
    { type: "turn_context", payload: { cwd: "/old/proj" } },
    { type: "session_meta", payload: { cwd: "/old/proj", runtime_workspace_roots: ["/old/proj"] } },
  ]);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  assert.equal(res.results[0].status, "done", res.results[0].error);
  assert.ok(fs.existsSync(src), "codex 不挪文件");
  assert.equal(res.results[0].movedTo, undefined);

  const recs = readJsonl(src);
  assert.equal(recs[0].payload.cwd, "/new/proj");
  assert.deepEqual(recs[0].payload.runtime_workspace_roots, ["/new/proj", "/other/lib"]);
  assert.equal(recs[1].payload.cwd, "/old/proj", "turn_context 不动");
  assert.equal(recs[2].payload.cwd, "/old/proj", "内嵌祖先 meta 不动");
  assert.deepEqual(recs[2].payload.runtime_workspace_roots, ["/old/proj"]);
});

test("③ openclaw：唯一顶层 cwd 记录被改写且不挪文件", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "openclaw-session.jsonl");
  writeJsonl(src, [
    { type: "session.started", cwd: "/old/proj", session: { id: "s1" } },
    { type: "model.completed" },
  ]);
  const opts = baseOpts({ agent: "openclaw", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  assert.equal(res.results[0].status, "done", res.results[0].error);
  const recs = readJsonl(src);
  assert.equal(recs[0].cwd, "/new/proj");
  assert.ok(fs.existsSync(src));
});

test("④ 损坏行原样保留且迁移成功", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "broken.jsonl");
  const raw = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/old/proj", runtime_workspace_roots: ["/old/proj"] } }),
    "{bad json",
    JSON.stringify({ type: "turn_context", payload: { cwd: "/old/proj" } }),
  ].join("\n") + "\n";
  fs.writeFileSync(src, raw);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  assert.equal(res.results[0].status, "done", res.results[0].error);
  const out = fs.readFileSync(src, "utf8");
  const lines = out.split("\n");
  assert.ok(lines.includes("{bad json"), "损坏行必须原样存在");
  assert.ok(out.endsWith("\n"), "文件必须以 \\n 结尾");
  const recs = lines.filter(Boolean).filter((l) => l !== "{bad json").map((l) => JSON.parse(l));
  assert.equal(recs[0].payload.cwd, "/new/proj");
  assert.equal(recs[1].payload.cwd, "/old/proj");
});

test("⑤ 目标同名文件已存在：该项 failed 且预置文件与源文件均不变", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  writeJsonl(src, [{ cwd: "/old/proj" }, { cwd: "/old/proj" }]);
  const destDir = path.join(sb.claudeRoot, encodeClaudeProject("/new/proj"));
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "claude-session.jsonl");
  const marker = "preexisting-bytes\n";
  fs.writeFileSync(dest, marker);
  const srcBefore = fs.readFileSync(src);
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  assert.equal(res.results[0].status, "failed");
  assert.ok(res.results[0].error);
  assert.equal(fs.readFileSync(dest, "utf8"), marker, "预置目标文件字节不变");
  assert.deepEqual(fs.readFileSync(src), srcBefore, "源文件也不应被改写");
});

test("⑥ 备份目录含原文件副本且 manifest.json 可解析、含 postHash", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-session.jsonl");
  const original = [{ type: "session_meta", payload: { cwd: "/old/proj" } }];
  writeJsonl(src, original);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  const batchDir = path.join(sb.backupRoot, res.batchId);
  const manifest = JSON.parse(fs.readFileSync(path.join(batchDir, "manifest.json"), "utf8"));
  assert.equal(manifest.id, res.batchId);
  assert.equal(manifest.type, "project");
  assert.equal(manifest.ops.length, 1);
  assert.equal(manifest.ops[0].status, "done");
  assert.ok(typeof manifest.ops[0].postHash === "string" && manifest.ops[0].postHash.length === 64);

  const backupFile = path.join(batchDir, manifest.ops[0].backup);
  assert.ok(fs.existsSync(backupFile));
  assert.deepEqual(readJsonl(backupFile), original, "备份是改写前的原始内容");
});

test("⑦ manifest 的 postHash 与迁移后文件实际 sha256 一致", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-session.jsonl");
  writeJsonl(src, [{ type: "session_meta", payload: { cwd: "/old/proj" } }]);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  const manifest = JSON.parse(fs.readFileSync(path.join(sb.backupRoot, res.batchId, "manifest.json"), "utf8"));
  assert.equal(manifest.ops[0].postHash, sha256(src));
  assert.equal(res.results[0].postHash, sha256(src));
});

test("⑧ 非 .jsonl 与含 :: 的 target 返回 failed 且不触碰文件", () => {
  const sb = sandbox();
  const txt = path.join(sb.allowedRoot, "note.txt");
  fs.writeFileSync(txt, "hello");
  const hermesRef = path.join(sb.allowedRoot, "synthetic::ref.jsonl");
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([txt, hermesRef], opts);
  assert.equal(res.results.length, 2);
  for (const r of res.results) assert.equal(r.status, "failed");
  assert.equal(fs.readFileSync(txt, "utf8"), "hello");
  assert.ok(!fs.existsSync(hermesRef), "含 :: 的合成引用根本不应被创建/触碰");

  const manifest = JSON.parse(fs.readFileSync(path.join(sb.backupRoot, res.batchId, "manifest.json"), "utf8"));
  assert.equal(manifest.ops.every((op: any) => op.status === "failed"), true);
});

test("批次语义：单项失败不中止其余项，结果全部进 manifest", () => {
  const sb = sandbox();
  const good = path.join(sb.allowedRoot, "good.jsonl");
  writeJsonl(good, [{ type: "session_meta", payload: { cwd: "/old/proj" } }]);
  const outside = path.join(sb.root, "elsewhere", "outside.jsonl");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  writeJsonl(outside, [{ cwd: "/old/proj" }]);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([good, outside], opts);
  const statuses = res.results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["done", "failed"]);
});

test("type=account 抛 not implemented", () => {
  const sb = sandbox();
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot, type: "account" });
  assert.throws(() => migrateSessions([], opts), /not implemented/);
});

test("rewriteJsonlAtomic：null 表示不改，无变更时不重写文件", () => {
  const sb = sandbox();
  const f = path.join(sb.root, "plain.jsonl");
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n');
  const before = fs.statSync(f).mtimeMs;
  const out = rewriteJsonlAtomic(f, () => null);
  assert.equal(out.changed, false);
  assert.deepEqual(out.changes, []);
  assert.equal(fs.readFileSync(f, "utf8"), '{"a":1}\n{"a":2}\n');
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test("encodeClaudeProject：斜杠转连字符且前导斜杠变前导连字符", () => {
  assert.equal(encodeClaudeProject("/Users/me/proj"), "-Users-me-proj");
});

// ---- fix round 1 回归：I1 failed 项 postHash ----

test("I1：文件仍在的 failed 项回填 postHash；无文件场景省略且 error 说明原因", () => {
  const sb = sandbox();
  const txt = path.join(sb.allowedRoot, "note.txt");
  fs.writeFileSync(txt, "hello");
  const outside = path.join(sb.root, "elsewhere", "outside.jsonl");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  writeJsonl(outside, [{ cwd: "/old/proj" }]);
  const missing = path.join(sb.allowedRoot, "missing.jsonl");
  const hermesRef = path.join(sb.allowedRoot, "synthetic::ref.jsonl");
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([txt, outside, missing, hermesRef], opts);
  const byPath = new Map(res.results.map((r) => [r.path, r]));
  assert.equal(byPath.get(txt)!.postHash, sha256(txt), ".txt failed 项带 postHash");
  assert.equal(byPath.get(outside)!.postHash, sha256(outside), "越界 failed 项带 postHash");
  assert.equal(byPath.has(missing), true);
  assert.equal(byPath.get(missing)!.postHash, undefined, "不存在 target 省略 postHash");
  assert.match(byPath.get(missing)!.error!, /postHash omitted/);
  assert.equal(byPath.get(hermesRef)!.postHash, undefined, "hermes 合成引用省略 postHash");
  assert.match(byPath.get(hermesRef)!.error!, /postHash omitted/);

  const manifest = JSON.parse(fs.readFileSync(path.join(sb.backupRoot, res.batchId, "manifest.json"), "utf8"));
  const mByPath = new Map<string, any>(manifest.ops.map((op: any) => [op.path, op]));
  assert.equal(mByPath.get(txt).postHash, sha256(txt));
  assert.equal(Object.hasOwn(mByPath.get(missing), "postHash"), false, "manifest 无文件项不得出现 postHash 键");
  assert.equal(Object.hasOwn(mByPath.get(hermesRef), "postHash"), false);
});

// ---- fix round 1 回归：I2/I3 非覆盖移动（link + unlink）----

test("I3：link 失败路径（目标目录只读）源文件完全未触碰", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  const original = [{ cwd: "/old/proj" }, { cwd: "/old/proj" }];
  writeJsonl(src, original);
  const destDir = path.join(sb.claudeRoot, encodeClaudeProject("/new/proj"));
  fs.mkdirSync(destDir, { recursive: true });
  fs.chmodSync(destDir, 0o555); // 预建只读目录：existsSync(dest)=false，但 linkSync 原子抛 EACCES
  const srcBefore = fs.readFileSync(src);
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });
  try {
    const res = migrateSessions([src], opts);
    assert.equal(res.results[0].status, "failed");
    assert.match(res.results[0].error!, /non-overwriting move failed \(EACCES\)/);
    assert.deepEqual(fs.readFileSync(src), srcBefore, "link 失败时源文件字节不变");
    assert.deepEqual(readJsonl(src), original, "源文件内容未被改写");
    assert.equal(fs.existsSync(path.join(destDir, "claude-session.jsonl")), false, "不应产生 dest 副本");
  } finally {
    fs.chmodSync(destDir, 0o755);
  }
});

test("I2/I3：link 成功但 unlink 失败 → 两份副本保留、报 failed、dest 不被改写", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  const original = [{ cwd: "/old/proj" }, { cwd: "/old/proj" }];
  writeJsonl(src, original);
  // 源目录只读：备份阶段仍可读，移动阶段 link 成功后 unlink 被 EACCES 拒绝。
  fs.chmodSync(sb.allowedRoot, 0o555);
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });
  try {
    const res = migrateSessions([src], opts);
    assert.equal(res.results[0].status, "failed");
    assert.match(res.results[0].error!, /both copies kept/);
    assert.ok(fs.existsSync(src), "源文件仍在");
    const dest = path.join(sb.claudeRoot, encodeClaudeProject("/new/proj"), "claude-session.jsonl");
    assert.ok(fs.existsSync(dest), "dest 副本也在");
    assert.deepEqual(readJsonl(dest), original, "unlink 失败后不得继续改写 dest");
    assert.deepEqual(readJsonl(src), original);
  } finally {
    fs.chmodSync(sb.allowedRoot, 0o755);
  }
});

test("I3：预置同名 dest 时 link 不变量兜底，源文件与预置文件均不变", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  writeJsonl(src, [{ cwd: "/old/proj" }]);
  const destDir = path.join(sb.claudeRoot, encodeClaudeProject("/new/proj"));
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "claude-session.jsonl");
  fs.writeFileSync(dest, "preexisting\n");
  const srcBefore = fs.readFileSync(src);
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const res = migrateSessions([src], opts);
  assert.equal(res.results[0].status, "failed");
  assert.equal(fs.readFileSync(dest, "utf8"), "preexisting\n");
  assert.deepEqual(fs.readFileSync(src), srcBefore);
  assert.equal(res.results[0].postHash, sha256(src), "failed 项同样回填 postHash");
});
