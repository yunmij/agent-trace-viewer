// render-account.test.ts — Task 6 控制器裁定①：render 层账户贴附。
// 独立 trace 页只拿 path，禁止反查 /api/sessions；账户 id/label 在 render 链路内补齐。
// 全程临时 HOME + 真实文件 fixture，不 mock。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "atv-render-acct-"));
// identity.ts 的默认 homedir 走 os.homedir()，POSIX 下即 $HOME；必须在导入 src/* 前固化。
process.env.HOME = tempHome;

const { renderTranscript } = await import("../src/render.ts");
const { addInput, removeInput } = await import("../src/config.ts");
const { saveAccountNote } = await import("../src/identity.ts");

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function writeLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj) + "\n");
}

const CODEX_AUTH_ID = "43922f38-1111-2222-3333-444444444444";
const CODEX_NOTE_ID = "aaaaaaaa-1234-5678-9abc-defdefdefdef";
const CODEX_PLAIN_ID = "bbbbbbbb-4321-8765-bcba-fedcfedcfedc";

test("codex 渲染结果按 auth/备注/兜底三分支贴账户标签，claude 挂共享身份，openclaw 留空", () => {
  fs.mkdirSync(path.join(tempHome, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, ".codex", "auth.json"),
    JSON.stringify({ tokens: { id_token: makeJwt({ email: "dev@example.com", chatgpt_account_id: CODEX_AUTH_ID }) } }),
  );
  saveAccountNote(CODEX_NOTE_ID, "团队共享号", tempHome);

  fs.mkdirSync(path.join(tempHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { subscriptionType: "team" } }),
  );
  fs.writeFileSync(path.join(tempHome, ".claude.json"), JSON.stringify({ userID: "abcdef0123456789xxxx" }));

  const root = path.join(tempHome, "fixtures");
  fs.mkdirSync(root, { recursive: true });

  const codexAuthFile = path.join(root, "rollout-auth.jsonl");
  writeLine(codexAuthFile, {
    type: "session_meta",
    payload: { id: "s1", cwd: "/tmp/proj-a", creator_account_id: CODEX_AUTH_ID, creator_user_id: "u1" },
  });
  const codexNoteFile = path.join(root, "rollout-note.jsonl");
  writeLine(codexNoteFile, {
    type: "session_meta",
    payload: { id: "s2", cwd: "/tmp/proj-b", creator_account_id: CODEX_NOTE_ID, creator_user_id: "u2" },
  });
  const codexPlainFile = path.join(root, "rollout-plain.jsonl");
  writeLine(codexPlainFile, {
    type: "session_meta",
    payload: { id: "s3", cwd: "/tmp/proj-c", creator_account_id: CODEX_PLAIN_ID, creator_user_id: "u3" },
  });
  const claudeFile = path.join(root, "claude-session.jsonl");
  writeLine(claudeFile, { type: "user", cwd: "/tmp/claude-proj", message: { role: "user", content: "你好" } });
  const openclawFile = path.join(root, "openclaw-session.jsonl");
  // model_change 是 detectFormat 识别 openclaw 的特征标记（额外输入源不靠路径前缀判定）。
  writeLine(openclawFile, { type: "session", id: "oc1", cwd: "/tmp/oc-proj" });
  fs.appendFileSync(openclawFile, JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "x" }) + "\n");
  const codexNoMetaFile = path.join(root, "rollout-no-meta.jsonl");
  writeLine(codexNoMetaFile, { type: "event_msg", payload: { type: "user_message", message: "hi" } });

  addInput(root);
  try {
    const auth = renderTranscript(codexAuthFile);
    assert.ok(!("error" in auth));
    assert.equal((auth as any).accountId, CODEX_AUTH_ID);
    assert.equal((auth as any).accountLabel, "dev@example.com");

    const note = renderTranscript(codexNoteFile) as any;
    assert.equal(note.accountId, CODEX_NOTE_ID);
    assert.equal(note.accountLabel, "团队共享号");

    const plain = renderTranscript(codexPlainFile) as any;
    assert.equal(plain.accountId, CODEX_PLAIN_ID);
    assert.equal(plain.accountLabel, "account-bbbbbbbb");

    const claude = renderTranscript(claudeFile) as any;
    assert.equal(claude.accountId, "abcdef01");
    assert.equal(claude.accountLabel, "team · abcdef01");

    const oc = renderTranscript(openclawFile) as any;
    assert.equal(oc.accountId, undefined);
    assert.equal(oc.accountLabel, undefined);

    const noMeta = renderTranscript(codexNoMetaFile) as any;
    assert.equal(noMeta.accountId, undefined);
    assert.equal(noMeta.accountLabel, undefined);
  } finally {
    removeInput(root);
  }
});

test("缓存命中时账户标签仍按最新备注重贴（文件 mtime 不变也能看到新备注）", () => {
  const root = path.join(tempHome, "fixtures-fresh");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "rollout-fresh.jsonl");
  writeLine(file, {
    type: "session_meta",
    payload: { id: "s9", cwd: "/tmp/proj-fresh", creator_account_id: CODEX_PLAIN_ID, creator_user_id: "u9" },
  });
  addInput(root);
  try {
    const first = renderTranscript(file) as any;
    assert.equal(first.accountLabel, "account-bbbbbbbb");

    // 不改文件、不改 mtime，仅新增备注；再次渲染必须命中缓存但看到新标签。
    saveAccountNote(CODEX_PLAIN_ID, "新备注名", tempHome);
    const second = renderTranscript(file) as any;
    assert.equal(second.accountId, CODEX_PLAIN_ID);
    assert.equal(second.accountLabel, "新备注名");
  } finally {
    removeInput(root);
  }
});

test("路径越界 / 非 jsonl 仍返回 error，不贴任何账户字段", () => {
  const outside = path.join(tempHome, "outside.jsonl");
  writeLine(outside, { type: "session_meta", payload: { creator_account_id: "x" } });
  const r1 = renderTranscript(outside);
  assert.ok("error" in r1);
  assert.equal((r1 as any).accountLabel, undefined);

  const r2 = renderTranscript(path.join(tempHome, "note.txt"));
  assert.ok("error" in r2);
});

test("超过 400MB 的会话返回明确的体积错误而非 V8 RangeError", () => {
  const root = path.join(tempHome, "huge-root");
  fs.mkdirSync(root, { recursive: true });
  const big = path.join(root, "huge.jsonl");
  // 稀疏文件：瞬间造出 >400MB 且不实际占盘
  const fd = fs.openSync(big, "w");
  fs.writeSync(fd, "x", 400 * 1024 * 1024 + 1);
  fs.closeSync(fd);

  addInput(root);
  try {
    const r = renderTranscript(big);
    assert.ok("error" in r);
    assert.match((r as { error: string }).error, /too large to render/);
  } finally {
    removeInput(root);
  }
});
