// scan-account.test.ts — 扫描链路账户字段：codex 首条 session_meta 归属、标签解析三分支、
// claude 身份挂载、openclaw/hermes 字段留空。全程临时 HOME + 真实文件 fixture，不 mock。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addInput, removeInput } from "../src/config.ts";
import { scanSessions, structMetaFromRecords, countNewlines } from "../src/scan.ts";
import { saveAccountNote } from "../src/identity.ts";
import { attachModel } from "../src/render.ts";

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

// ---- 大文件支持：分块换行计数在小 chunk 下与真实行数一致（含多字节与无尾换行）----

test("countNewlines 小 chunk 多块拼接计数正确，且 scanSessions 能解析大文件的开头元数据", () => {
  const home = makeTempHome();
  const root = path.join(home, "big-root");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "big.jsonl");
  // 首条带 cwd/account 的 session_meta，后续造足够多行使文件跨越多个小 chunk
  const recs = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/big/proj", creator_account_id: "acct-big", creator_user_id: "user-big" } }),
  ];
  for (let i = 0; i < 500; i++) recs.push(JSON.stringify({ type: "event_msg", i, pad: "中文 padding".repeat(8) }));
  fs.writeFileSync(file, recs.join("\n") + "\n");

  assert.equal(countNewlines(file, 64), recs.length, "64 字节小 chunk 也数对行数");
  assert.equal(countNewlines(file, 4096), recs.length, "常规 chunk 结果一致");

  addInput(root);
  try {
    const row = scanSessions(home).find((r) => r.path === file);
    assert.ok(row);
    assert.equal(row!.lines, recs.length);
    assert.equal(row!.cwd, "/big/proj", "只读前缀即可取到归属元数据，不依赖整文件读入");
    assert.equal(row!.accountId, "acct-big");
  } finally {
    removeInput(root);
  }
});

// ---- 会话主模型提取 ----

test("structMetaFromRecords 提取各 agent 首个真实模型，<synthetic> 占位跳过取下一个", () => {
  // claude：assistant 记录的 message.model；首个是合成占位时跳过。
  const claudeRecs = [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [] } },
    { type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [] } },
  ];
  assert.equal(structMetaFromRecords(claudeRecs).model, "claude-opus-5-5");

  // codex：turn_context.payload.model
  const codexRecs = [
    { type: "session_meta", payload: { cwd: "/p" } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
  ];
  assert.equal(structMetaFromRecords(codexRecs).model, "gpt-6.1-sol");

  // openclaw：model_change.modelId 与 assistant message.model
  assert.equal(
    structMetaFromRecords([{ type: "model_change", modelId: "ep-20260130-qgg9r" }]).model,
    "ep-20260130-qgg9r",
  );
  assert.equal(
    structMetaFromRecords([{ type: "message", message: { role: "assistant", model: "oc-model-1" } }]).model,
    "oc-model-1",
  );

  // 没有任何模型记录时留 undefined（而非空串）。
  assert.equal(structMetaFromRecords([{ type: "user", message: { role: "user", content: "x" } }]).model, undefined);
});

test("attachModel 从 events 取首个带 model 的事件，已带 model 时不覆盖", () => {
  const base = {
    path: "/x.jsonl", cwd: "/p", sessionId: "s", title: "t", count: 2,
    events: [
      { seq: 0, role: "user" as const, ts: "" },
      { seq: 1, role: "assistant" as const, ts: "", model: "m-first" },
      { seq: 2, role: "assistant" as const, ts: "", model: "m-second" },
    ],
  };
  assert.equal(attachModel(base).model, "m-first");
  assert.equal(attachModel({ ...base, model: "preset" }).model, "preset");
  assert.equal(attachModel({ ...base, events: [{ seq: 0, role: "user" as const, ts: "" }] }).model, undefined);
});

test("巨首行（单条记录超过字节前缀）不挡后续 turn_context 的模型与 cwd 提取", () => {
  const home = makeTempHome();
  const root = path.join(home, "huge-firstline");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "rollout-huge.jsonl");
  // 第一条 session_meta 塞入超大 payload（远超 512KB 字节前缀），第 4 行才是 turn_context。
  const giant = JSON.stringify({
    type: "session_meta",
    payload: { cwd: "/huge/proj", creator_account_id: "acct-huge", padding: "x".repeat(900 * 1024) },
  });
  const lines = [
    giant,
    JSON.stringify({ type: "event_msg", payload: { type: "noise" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } }),
    JSON.stringify({ type: "turn_context", payload: { cwd: "/huge/proj", model: "gpt-mega-1" } }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");

  addInput(root);
  try {
    const row = scanSessions(home).find((r) => r.path === file);
    assert.ok(row);
    assert.equal(row!.model, "gpt-mega-1", "巨首行之后的 turn_context 模型仍被提取");
    assert.equal(row!.cwd, "/huge/proj");
    assert.equal(row!.accountId, "acct-huge", "首条 meta 被截断跳过不影响其字段——若截断发生则此字段为空，此处锁定完整解析");
  } finally {
    removeInput(root);
  }
});
