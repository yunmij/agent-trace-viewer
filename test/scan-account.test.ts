// scan-account.test.ts — 扫描链路账户字段：codex 首条 session_meta 归属、标签解析三分支、
// claude 身份挂载、openclaw/hermes 字段留空。全程临时 HOME + 真实文件 fixture，不 mock。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addInput, removeInput } from "../src/config.ts";
import { scanSessions, structMetaFromRecords } from "../src/scan.ts";
import { saveAccountNote } from "../src/identity.ts";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atv-scan-"));
}

// 拼结构合法的 JWT（只解 payload 不验签），用于造临时 HOME 下的 codex auth.json。
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function writeLine(file: string, obj: unknown): void {
  fs.writeFileSync(file, JSON.stringify(obj) + "\n");
}

// codex 首条 session_meta 的固定账户 id（brief 指定前缀 43922f38）。
const CODEX_AUTH_ID = "43922f38-1111-2222-3333-444444444444";
const CODEX_NOTE_ID = "aaaaaaaa-1234-5678-9abc-defdefdefdef";
const CODEX_PLAIN_ID = "bbbbbbbb-4321-8765-bcba-fedcfedcfedc";

test("structMetaFromRecords 只取首条 session_meta 的 creator 字段，内嵌 meta 被忽略", () => {
  const recs = [
    {
      type: "session_meta",
      payload: {
        id: "sess-first",
        cwd: "/tmp/first-project",
        creator_account_id: CODEX_AUTH_ID,
        creator_user_id: "user-first",
      },
    },
    // 真实文件里可能出现的内嵌 session_meta，账户 id 不同，必须忽略。
    {
      type: "session_meta",
      payload: {
        id: "sess-embedded",
        cwd: "/tmp/embedded-project",
        creator_account_id: "99999999-aaaa-bbbb-cccc-dddddddddddd",
        creator_user_id: "user-embedded",
      },
    },
  ];
  const sm = structMetaFromRecords(recs);
  assert.equal(sm.accountId, CODEX_AUTH_ID);
  assert.equal(sm.accountUserId, "user-first");
  assert.equal(sm.cwd, "/tmp/first-project");
});

test("scanSessions 给 codex 行按 auth/备注/兜底三分支解析账户标签，claude 行挂共享身份，openclaw 行留空", () => {
  const home = makeTempHome();

  // 临时 HOME：codex 登录态（账户 id 与首条 fixture 一致 → 标签取邮箱）。
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { id_token: makeJwt({ email: "dev@example.com", chatgpt_account_id: CODEX_AUTH_ID }) } }),
  );
  // 账户备注：第二个 codex 账户走备注分支。
  saveAccountNote(CODEX_NOTE_ID, "团队共享号", home);

  // 临时 HOME：claude 凭据。
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { subscriptionType: "team" } }),
  );
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ userID: "abcdef0123456789xxxx" }));

  // fixture 目录通过 extraInputs 接入（DEFAULT_ROOTS 锚的是真实 HOME，临时 HOME 不在其中）。
  const root = path.join(home, "fixtures");
  fs.mkdirSync(root, { recursive: true });

  const codexAuthFile = path.join(root, "rollout-2026-01-01-auth.jsonl");
  writeLine(codexAuthFile, {
    type: "session_meta",
    payload: { id: "s1", cwd: "/tmp/proj-a", creator_account_id: CODEX_AUTH_ID, creator_user_id: "u1" },
  });

  const codexNoteFile = path.join(root, "rollout-2026-01-02-note.jsonl");
  writeLine(codexNoteFile, {
    type: "session_meta",
    payload: { id: "s2", cwd: "/tmp/proj-b", creator_account_id: CODEX_NOTE_ID, creator_user_id: "u2" },
  });

  const codexPlainFile = path.join(root, "rollout-2026-01-03-plain.jsonl");
  writeLine(codexPlainFile, {
    type: "session_meta",
    payload: { id: "s3", cwd: "/tmp/proj-c", creator_account_id: CODEX_PLAIN_ID, creator_user_id: "u3" },
  });

  const claudeFile = path.join(root, "claude-session.jsonl");
  writeLine(claudeFile, {
    type: "user",
    cwd: "/tmp/claude-proj",
    message: { role: "user", content: "帮我看下这个项目" },
  });

  const openclawFile = path.join(root, "openclaw-session.jsonl");
  writeLine(openclawFile, { type: "session.started", workspaceDir: "/tmp/oc-proj" });

  addInput(root);
  try {
    const rows = scanSessions(home);
    const byPath = new Map(rows.map((r) => [r.path, r]));

    const codexAuthRow = byPath.get(codexAuthFile)!;
    assert.ok(codexAuthRow);
    assert.equal(codexAuthRow.agent, "codex");
    assert.equal(codexAuthRow.accountId, CODEX_AUTH_ID);
    assert.equal(codexAuthRow.accountLabel, "dev@example.com");

    const codexNoteRow = byPath.get(codexNoteFile)!;
    assert.ok(codexNoteRow);
    assert.equal(codexNoteRow.accountId, CODEX_NOTE_ID);
    assert.equal(codexNoteRow.accountLabel, "团队共享号");

    const codexPlainRow = byPath.get(codexPlainFile)!;
    assert.ok(codexPlainRow);
    assert.equal(codexPlainRow.accountId, CODEX_PLAIN_ID);
    assert.equal(codexPlainRow.accountLabel, "account-bbbbbbbb");

    const claudeRow = byPath.get(claudeFile)!;
    assert.ok(claudeRow);
    assert.equal(claudeRow.agent, "claude");
    assert.equal(claudeRow.accountId, "abcdef01");
    assert.equal(claudeRow.accountLabel, "team · abcdef01");

    const openclawRow = byPath.get(openclawFile)!;
    assert.ok(openclawRow);
    assert.equal(openclawRow.agent, "openclaw");
    assert.equal(openclawRow.accountId, undefined);
    assert.equal(openclawRow.accountLabel, undefined);
  } finally {
    removeInput(root);
  }
});

test("claude 身份读取为 null 时 claude 行两个账户字段留空", () => {
  const home = makeTempHome(); // 不放任何凭据
  const root = path.join(home, "fixtures");
  fs.mkdirSync(root, { recursive: true });
  const claudeFile = path.join(root, "lonely-claude.jsonl");
  writeLine(claudeFile, { type: "user", cwd: "/tmp/x", message: { role: "user", content: "hello" } });

  addInput(root);
  try {
    const rows = scanSessions(home);
    const row = rows.find((r) => r.path === claudeFile)!;
    assert.ok(row);
    assert.equal(row.agent, "claude");
    assert.equal(row.accountId, undefined);
    assert.equal(row.accountLabel, undefined);
  } finally {
    removeInput(root);
  }
});

test("codex 文件缺 session_meta 时账户字段留空且不抛异常", () => {
  const home = makeTempHome();
  const root = path.join(home, "fixtures");
  fs.mkdirSync(root, { recursive: true });
  const f = path.join(root, "rollout-no-meta.jsonl");
  writeLine(f, { type: "event_msg", payload: { type: "user_message", message: "hi" } });

  addInput(root);
  try {
    const rows = scanSessions(home);
    const row = rows.find((r) => r.path === f)!;
    assert.ok(row);
    assert.equal(row.agent, "codex");
    assert.equal(row.accountId, undefined);
    assert.equal(row.accountLabel, undefined);
  } finally {
    removeInput(root);
  }
});
