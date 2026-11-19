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
  listBatches,
  readBatch,
  rollbackBatch,
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

// ---- Task 4：账号迁移、批次查询与漂移检测回滚 ----

function accountOpts(sb: ReturnType<typeof sandbox>, partial: Partial<MigrateOpts> = {}): MigrateOpts {
  return baseOpts({
    agent: "codex",
    value: "acct-B",
    type: "account",
    userId: "user-B",
    allowedRoots: [sb.allowedRoot],
    claudeRoot: sb.claudeRoot,
    backupRoot: sb.backupRoot,
    ...partial,
  });
}

test("⑨ codex 账号迁移：仅首条 session_meta 的两个 creator 字段更新，内嵌 meta 保持旧 id", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-account.jsonl");
  writeJsonl(src, [
    { type: "session_meta", payload: { cwd: "/old/proj", creator_account_id: "acct-A", creator_user_id: "user-A" } },
    { type: "turn_context", payload: { cwd: "/old/proj" } },
    { type: "session_meta", payload: { cwd: "/old/proj", creator_account_id: "acct-A", creator_user_id: "user-A" } },
  ]);

  const res = migrateSessions([src], accountOpts(sb));
  assert.equal(res.results[0].status, "done", res.results[0].error);
  assert.ok(fs.existsSync(src), "codex 账号迁移不挪文件");

  const recs = readJsonl(src);
  assert.equal(recs[0].payload.creator_account_id, "acct-B");
  assert.equal(recs[0].payload.creator_user_id, "user-B");
  assert.equal(recs[0].payload.cwd, "/old/proj", "cwd 等非归属字段不动");
  assert.equal(recs[1].payload.cwd, "/old/proj");
  assert.equal(recs[2].payload.creator_account_id, "acct-A", "内嵌祖先 meta 的 creator 保持旧值");
  assert.equal(recs[2].payload.creator_user_id, "user-A");

  const manifest = JSON.parse(fs.readFileSync(path.join(sb.backupRoot, res.batchId, "manifest.json"), "utf8"));
  assert.equal(manifest.type, "account");
  assert.deepEqual(
    manifest.ops[0].changes.map((c: any) => c.field).sort(),
    ["payload.creator_account_id", "payload.creator_user_id"],
  );
});

test("⑩ 账号迁移缺 userId：该项 failed 且文件字节不变", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-account.jsonl");
  writeJsonl(src, [
    { type: "session_meta", payload: { creator_account_id: "acct-A", creator_user_id: "user-A" } },
  ]);
  const before = fs.readFileSync(src);

  for (const bad of [undefined, ""]) {
    const res = migrateSessions([src], accountOpts(sb, { userId: bad }));
    assert.equal(res.results[0].status, "failed");
    assert.match(res.results[0].error!, /userId/);
    assert.deepEqual(fs.readFileSync(src), before, "缺 userId 时文件必须字节不变");
  }
});

test("⑩b 非 codex agent 的 account 迁移：该项 failed 且文件不变", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-account.jsonl");
  writeJsonl(src, [{ type: "session_meta", payload: { creator_account_id: "acct-A" } }]);
  const before = fs.readFileSync(src);

  const res = migrateSessions([src], accountOpts(sb, { agent: "claude" }));
  assert.equal(res.results[0].status, "failed");
  assert.match(res.results[0].error!, /codex/);
  assert.deepEqual(fs.readFileSync(src), before);
});

test("⑪ A→B→C 连续迁移后回滚第一批：漂移冲突整批中止，磁盘保持 C 状态", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-account.jsonl");
  writeJsonl(src, [
    { type: "session_meta", payload: { creator_account_id: "acct-A", creator_user_id: "user-A" } },
  ]);

  const r1 = migrateSessions([src], accountOpts(sb, { value: "acct-B", userId: "user-B" }));
  const r2 = migrateSessions([src], accountOpts(sb, { value: "acct-C", userId: "user-C" }));
  assert.equal(r1.results[0].status, "done");
  assert.equal(r2.results[0].status, "done");

  const rb = rollbackBatch(r1.batchId, sb.backupRoot);
  assert.equal(rb.batchId, r1.batchId, "中止时不产生新批次 id");
  assert.ok(rb.results.length >= 1);
  assert.ok(rb.results.every((r) => r.status === "failed"), "整批中止，无一项执行还原");
  assert.ok(rb.results.some((r) => /drift/.test(r.error ?? "")), "冲突项带漂移 error");

  const recs = readJsonl(src);
  assert.equal(recs[0].payload.creator_account_id, "acct-C", "文件保持二次迁移后的 C 状态");
  assert.equal(recs[0].payload.creator_user_id, "user-C");
  const dirs = fs.readdirSync(sb.backupRoot);
  assert.ok(!dirs.includes(`rollback-${r1.batchId}`), "漂移中止不得创建 rollback 安全备份目录");
});

test("⑫ 正常批次回滚（claude 移动场景）：路径与内容还原，rollback-* 安全备份存在", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  const original = [
    { cwd: "/old/proj", type: "summary" },
    { cwd: "/old/proj", type: "user" },
  ];
  writeJsonl(src, original);
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const r1 = migrateSessions([src], opts);
  const dest = path.join(sb.claudeRoot, encodeClaudeProject("/new/proj"), "claude-session.jsonl");
  assert.equal(r1.results[0].status, "done");
  assert.ok(fs.existsSync(dest) && !fs.existsSync(src));

  const rb = rollbackBatch(r1.batchId, sb.backupRoot);
  assert.equal(rb.results[0].status, "done", rb.results[0].error);
  assert.ok(fs.existsSync(src), "文件挪回原路径");
  assert.ok(!fs.existsSync(dest), "movedTo 路径文件已移除");
  assert.deepEqual(readJsonl(src), original, "内容还原为迁移前状态");

  const rollbackDir = path.join(sb.backupRoot, `rollback-${r1.batchId}`);
  assert.ok(fs.existsSync(rollbackDir), "rollback-* 安全备份目录存在");
  const rbManifest = JSON.parse(fs.readFileSync(path.join(rollbackDir, "manifest.json"), "utf8"));
  assert.equal(rbManifest.type, "rollback");
  assert.equal(rbManifest.rollbackOf, r1.batchId);
  assert.equal(rbManifest.ops[0].status, "done");
});

test("⑫b 正常批次回滚（codex 原地改写场景）：内容字节级还原", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-session.jsonl");
  const original = [{ type: "session_meta", payload: { cwd: "/old/proj" } }];
  writeJsonl(src, original);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const r1 = migrateSessions([src], opts);
  const manifest1 = JSON.parse(fs.readFileSync(path.join(sb.backupRoot, r1.batchId, "manifest.json"), "utf8"));
  const backupFile = path.join(sb.backupRoot, r1.batchId, manifest1.ops[0].backup);
  const originalBytes = fs.readFileSync(backupFile);

  const rb = rollbackBatch(r1.batchId, sb.backupRoot);
  assert.equal(rb.results[0].status, "done", rb.results[0].error);
  assert.deepEqual(fs.readFileSync(src), originalBytes, "原地文件按备份字节级还原");
});

test("⑬ readBatch 路径穿越防护：../、分隔符、.. 与缺失 manifest 一律抛错", () => {
  const sb = sandbox();
  assert.throws(() => readBatch("../etc", sb.backupRoot), /invalid batch id/);
  assert.throws(() => readBatch("a/b", sb.backupRoot), /invalid batch id/);
  assert.throws(() => readBatch("a\\b", sb.backupRoot), /invalid batch id/);
  assert.throws(() => readBatch("..", sb.backupRoot), /invalid batch id/);
  assert.throws(() => readBatch("no-such-batch", sb.backupRoot), /not found|unreadable|invalid/i);
});

test("⑭ listBatches：按时间倒序、计数正确，无 manifest 的子目录跳过", () => {
  const sb = sandbox();
  const f1 = path.join(sb.allowedRoot, "s1.jsonl");
  const f2 = path.join(sb.allowedRoot, "s2.jsonl");
  writeJsonl(f1, [{ type: "session_meta", payload: { cwd: "/old/proj" } }]);
  writeJsonl(f2, [{ type: "session_meta", payload: { cwd: "/old/proj" } }, { cwd: "/old/proj" }]);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const r1 = migrateSessions([f1], opts);
  const r2 = migrateSessions([f2, f1], opts);
  // 噪音：无 manifest 的目录与普通文件，必须被跳过而不是抛错。
  fs.mkdirSync(path.join(sb.backupRoot, "junk-dir"), { recursive: true });
  fs.writeFileSync(path.join(sb.backupRoot, "junk-file"), "x");

  const list = listBatches(sb.backupRoot);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, r2.batchId, "最新批次排在最前");
  assert.equal(list[1].id, r1.batchId);
  const byId = new Map(list.map((b) => [b.id, b]));
  assert.deepEqual(
    { opCount: byId.get(r1.batchId)!.opCount, doneCount: byId.get(r1.batchId)!.doneCount, type: byId.get(r1.batchId)!.type },
    { opCount: 1, doneCount: 1, type: "project" },
  );
  assert.equal(byId.get(r2.batchId)!.opCount, 2);
  assert.equal(byId.get(r2.batchId)!.doneCount, 2);
  assert.equal(typeof list[0].createdAt, "string");
});

test("⑭b listBatches 默认保持 summary 形状（无 ops），withOps=true 才透传操作明细", () => {
  const sb = sandbox();
  const f = path.join(sb.allowedRoot, "s1.jsonl");
  writeJsonl(f, [{ type: "session_meta", payload: { cwd: "/old/proj" } }]);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });
  migrateSessions([f], opts);

  const def = listBatches(sb.backupRoot);
  assert.equal(def.length, 1);
  // 控制器裁定：默认响应不得携带 ops，批次列表保持轻量。
  assert.deepEqual(Object.keys(def[0]).sort(), ["createdAt", "doneCount", "id", "opCount", "type"]);
  assert.equal(def[0].ops, undefined);

  const detailed = listBatches(sb.backupRoot, false, true);
  assert.equal(detailed.length, 1);
  assert.ok(Array.isArray(detailed[0].ops));
  assert.equal(detailed[0].ops!.length, 1);
  const op = detailed[0].ops![0];
  assert.equal(op.path, f);
  assert.equal(op.status, "done");
  assert.equal(op.error, null);
  assert.equal(op.movedTo, null);
  assert.deepEqual(op.changes, [{ field: "payload.cwd", from: "/old/proj", to: "/new/proj" }]);
  // 内部账本字段不得经摘要接口外泄。
  assert.equal((op as any).backup, undefined);
  assert.equal((op as any).postHash, undefined);
  assert.equal((op as any).destCandidates, undefined);
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

// ---- fix round 1：C1 failed 移动项不得被回滚静默吞掉 ----

test("C1a：真实 failed claude 移动项的 manifest 落 destCandidates，回滚不把它当漂移冲突", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  const original = [{ cwd: "/old/proj" }, { cwd: "/old/proj" }];
  writeJsonl(src, original);
  const dest = path.join(sb.claudeRoot, encodeClaudeProject("/new/proj"), "claude-session.jsonl");
  fs.chmodSync(sb.allowedRoot, 0o555); // link 成功、unlink EACCES → failed 且两份副本都在
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });
  try {
    const res = migrateSessions([src], opts);
    assert.equal(res.results[0].status, "failed");
    const manifest = JSON.parse(fs.readFileSync(path.join(sb.backupRoot, res.batchId, "manifest.json"), "utf8"));
    const op = manifest.ops[0];
    assert.equal(op.status, "failed");
    assert.ok(Array.isArray(op.destCandidates) && op.destCandidates.includes(dest), "destCandidates 必须记录 destGuess");
    assert.ok(op.destCandidates.includes(src));

    // 实体仍在 ledger 位置上 → 不构成漂移冲突；批次无 done 项时回滚产出空安全备份而非中止。
    const rb = rollbackBatch(res.batchId, sb.backupRoot);
    assert.ok(rb.results.every((r) => r.status !== "failed" || !/drift/.test(r.error ?? "")), "存在实体的 failed 项不得报漂移");
    assert.ok(fs.existsSync(path.join(sb.backupRoot, `rollback-${res.batchId}`, "manifest.json")));
  } finally {
    fs.chmodSync(sb.allowedRoot, 0o755);
  }
});

test("C1b：link+unlink 成功后改写失败的孤儿形态——所有 ledger 位置无实体时回滚整批中止", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "claude-session.jsonl");
  writeJsonl(src, [{ cwd: "/old/proj" }]);
  const opts = baseOpts({ agent: "claude", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  // 先跑一次成功批次拿到真实 dest 路径与 manifest，再改写成 ledger 边角形态：
  // status=failed、movedTo=null、原 path 已不存在（link+unlink 成功）、destCandidates 记录 destGuess。
  const r1 = migrateSessions([src], opts);
  const manifestPath = path.join(sb.backupRoot, r1.batchId, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dest = manifest.ops[0].movedTo;
  assert.ok(fs.existsSync(dest) && !fs.existsSync(src));
  manifest.ops[0].status = "failed";
  manifest.ops[0].movedTo = null;
  manifest.ops[0].destCandidates = [src, dest];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // 子场景 1：孤儿文件仍在 destGuess → 不报缺失冲突。
  const rb1 = rollbackBatch(r1.batchId, sb.backupRoot);
  assert.ok(!rb1.results.some((r) => /drift/.test(r.error ?? "")));
  fs.rmSync(path.join(sb.backupRoot, `rollback-${r1.batchId}`), { recursive: true, force: true });

  // 子场景 2：孤儿也丢失（所有 ledger 位置均无实体）→ 整批中止、零触盘、无 rollback 目录。
  fs.unlinkSync(dest);
  const rb2 = rollbackBatch(r1.batchId, sb.backupRoot);
  assert.ok(rb2.results.length >= 1);
  assert.ok(rb2.results.every((r) => r.status === "failed"));
  assert.ok(rb2.results.some((r) => /drift conflict: failed op has no backing file/.test(r.error ?? "")), "冲突项必须带 failed 项无实体的漂移 error");
  assert.ok(!fs.existsSync(src) && !fs.existsSync(dest), "磁盘保持中止前状态");
  assert.ok(!fs.existsSync(path.join(sb.backupRoot, `rollback-${r1.batchId}`)), "中止不得创建 rollback 安全备份");
});

// ---- fix round 1：I1 listBatches 契约固化 ----

test("I1：listBatches 默认隐藏 rollback 批次，includeRollbacks=true 才列出且类型联合正确", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-session.jsonl");
  writeJsonl(src, [{ type: "session_meta", payload: { cwd: "/old/proj" } }]);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });
  const r1 = migrateSessions([src], opts);
  rollbackBatch(r1.batchId, sb.backupRoot);

  const defaultList = listBatches(sb.backupRoot);
  assert.deepEqual(defaultList.map((b) => b.id), [r1.batchId], "主列表不返回 rollback 批次");
  assert.equal(defaultList[0].type, "project");

  const all = listBatches(sb.backupRoot, true);
  assert.equal(all.length, 2);
  const rollbackEntry = all.find((b) => b.type === "rollback");
  assert.ok(rollbackEntry, "显式包含时 rollback 批次可见且 type 可判别");
  assert.equal(rollbackEntry!.id, `rollback-${r1.batchId}`);
});

// ---- fix round 1：Minor ③ undo-of-undo 实测 ----

test("Minor③：对 rollback 安全备份批次再回滚，文件恢复为迁移后状态（undo-of-undo）", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "codex-session.jsonl");
  writeJsonl(src, [{ type: "session_meta", payload: { cwd: "/old/proj" } }]);
  const opts = baseOpts({ agent: "codex", value: "/new/proj", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });

  const r1 = migrateSessions([src], opts);
  assert.equal(readJsonl(src)[0].payload.cwd, "/new/proj");
  const rb1 = rollbackBatch(r1.batchId, sb.backupRoot);
  assert.equal(readJsonl(src)[0].payload.cwd, "/old/proj", "第一次回滚还原");

  const rb2 = rollbackBatch(rb1.batchId, sb.backupRoot);
  assert.equal(rb2.results[0].status, "done", rb2.results[0].error);
  assert.equal(readJsonl(src)[0].payload.cwd, "/new/proj", "undo-of-undo 恢复迁移后状态");
  const nestedDir = path.join(sb.backupRoot, `rollback-${rb1.batchId}`);
  const nestedManifest = JSON.parse(fs.readFileSync(path.join(nestedDir, "manifest.json"), "utf8"));
  assert.equal(nestedManifest.type, "rollback");
  assert.equal(nestedManifest.rollbackOf, rb1.batchId);
});

// ---- 大文件分块路径：小 chunk 强制多块拼接，验证与整读实现语义等价 ----

test("rewriteJsonlAtomic 极小 chunk 下多块拼接：多字节字符/空行/损坏行/无尾换行均保真", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "chunked.jsonl");
  // 含中文多字节字符（跨 chunk 切割）、空行、损坏行，且文件无结尾换行
  const lines = [
    JSON.stringify({ type: "user", cwd: "/旧/工程", text: "你好世界，这是一条足够长的中文内容用于跨块切割".repeat(4) }),
    "",
    "{bad json 损坏行",
    JSON.stringify({ type: "assistant", cwd: "/旧/工程", text: "second" }),
  ];
  fs.writeFileSync(src, lines.join("\n")); // 故意不加结尾 \n

  const r = rewriteJsonlAtomic(src, (rec) => (typeof rec.cwd === "string" ? { ...rec, cwd: "/新/工程" } : null), [], 16);
  assert.equal(r.changed, true);

  const raw = fs.readFileSync(src, "utf8");
  const out = raw.split("\n");
  assert.equal(out[out.length - 1], "", "输出以换行结尾");
  out.pop();
  assert.equal(out.length, lines.length, "行数不丢不增");
  assert.equal(JSON.parse(out[0]).cwd, "/新/工程");
  assert.equal(JSON.parse(out[0]).text, JSON.parse(lines[0]).text, "多字节字符无损");
  assert.equal(out[1], "", "空行保留");
  assert.equal(out[2], "{bad json 损坏行", "损坏行逐字保留");
  assert.equal(JSON.parse(out[3]).cwd, "/新/工程");
});

test("rewriteJsonlAtomic 无变更时不创建临时文件且原文件字节不变", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "nochange.jsonl");
  writeJsonl(src, [{ type: "user", cwd: "/keep" }]);
  const before = fs.readFileSync(src);
  const r = rewriteJsonlAtomic(src, () => null, [], 8);
  assert.equal(r.changed, false);
  assert.deepEqual(fs.readFileSync(src), before);
  assert.equal(fs.readdirSync(sb.allowedRoot).filter((f) => f.startsWith(".migrate-")).length, 0);
});

test("分块 sha256（manifest 的 postHash）与一次性哈希一致", () => {
  const sb = sandbox();
  const src = path.join(sb.allowedRoot, "hash.jsonl");
  writeJsonl(src, Array.from({ length: 200 }, (_, i) => ({ i, cwd: `/p/${i}`, pad: "x".repeat(100) })));
  const opts = baseOpts({ agent: "codex", value: "/new/p", allowedRoots: [sb.allowedRoot], claudeRoot: sb.claudeRoot, backupRoot: sb.backupRoot });
  const res = migrateSessions([src], opts);
  const batch = readBatch(res.batchId, sb.backupRoot);
  const expected = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex");
  assert.equal(batch.ops[0].postHash, expected, "小 chunk 分块哈希与整文件哈希等价");
});
