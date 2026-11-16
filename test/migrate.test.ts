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
