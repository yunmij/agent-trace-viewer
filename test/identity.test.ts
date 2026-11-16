// identity.test.ts — 账户身份模块测试：用临时 HOME 隔离真实凭据，全程不碰 ~ 下的真实文件
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeJwtPayload,
  getClaudeIdentity,
  getCodexAuthIdentity,
  readAccountNotes,
  saveAccountNote,
} from "../src/identity.ts";

// 造一个空的临时目录当 HOME，每个用例各自一份，互不污染。
function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atv-"));
}

// 用 base64url 拼一个结构合法的 JWT，签名段随意，模块只解 payload 不验签。
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("两个凭据文件齐全时返回正确的 claude identity", () => {
  const home = makeTempHome();
  const userID = "abcdef0123456789xxxx"; // 20 位哈希，前 8 位为 abcdef01
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { subscriptionType: "team" } }),
  );
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ userID }));

  const info = getClaudeIdentity(home);
  assert.ok(info);
  assert.equal(info.kind, "claude");
  assert.equal(info.id, "abcdef01");
  assert.equal(info.label, "team · abcdef01");
});

test("codex auth.json 的 JWT 解出 email 与 account id", () => {
  const home = makeTempHome();
  const token = makeJwt({ email: "dev@example.com", chatgpt_account_id: "acct-12345" });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: token } }));

  const info = getCodexAuthIdentity(home);
  assert.ok(info);
  assert.equal(info.kind, "codex");
  assert.equal(info.label, "dev@example.com");
  assert.equal(info.id, "acct-12345");
  assert.equal(info.email, "dev@example.com");
});

test("codex JWT 缺 email claim 时 label 回退为 accountId 且不挂 email 字段", () => {
  const home = makeTempHome();
  const token = makeJwt({ chatgpt_account_id: "acct-no-email" });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: token } }));

  const info = getCodexAuthIdentity(home);
  assert.ok(info);
  assert.equal(info.kind, "codex");
  assert.equal(info.id, "acct-no-email");
  assert.equal(info.label, "acct-no-email");
  assert.equal(info.email, undefined);
});

test("凭据文件全缺时两个 getter 返回 null 且不抛异常", () => {
  const home = makeTempHome();
  assert.equal(getClaudeIdentity(home), null);
  assert.equal(getCodexAuthIdentity(home), null);
});

test("凭据 JSON 损坏时返回 null 且不抛异常", () => {
  const home = makeTempHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{ broken json");
  fs.writeFileSync(path.join(home, ".claude.json"), "also broken");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "not json at all");

  assert.equal(getClaudeIdentity(home), null);
  assert.equal(getCodexAuthIdentity(home), null);
});

test("decodeJwtPayload 对非三段式 token 抛 invalid jwt", () => {
  assert.throws(() => decodeJwtPayload("not-a-jwt"), /invalid jwt/);
});

test("decodeJwtPayload 解出 payload 且不验签", () => {
  const token = makeJwt({ email: "a@b.com", chatgpt_account_id: "x" });
  const payload = decodeJwtPayload(token);
  assert.equal(payload.email, "a@b.com");
  assert.equal(payload.chatgpt_account_id, "x");
});

test("notes 文件不存在时 readAccountNotes 返回空 codex 表", () => {
  const home = makeTempHome();
  assert.deepEqual(readAccountNotes(home), { codex: {} });
});

test("saveAccountNote 写入后 readAccountNotes 能读回，路径为 ~/.agent-trace-viewer/accounts.json", () => {
  const home = makeTempHome();
  saveAccountNote("acct-12345", "dev@example.com", home);

  const file = path.join(home, ".agent-trace-viewer", "accounts.json");
  assert.ok(fs.existsSync(file));
  // 两空格缩进
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ codex: { "acct-12345": "dev@example.com" } }, null, 2));
  assert.deepEqual(readAccountNotes(home), { codex: { "acct-12345": "dev@example.com" } });
});

test("saveAccountNote 多次写入保留既有备注", () => {
  const home = makeTempHome();
  saveAccountNote("acct-1", "one@example.com", home);
  saveAccountNote("acct-2", "two@example.com", home);
  assert.deepEqual(readAccountNotes(home), {
    codex: { "acct-1": "one@example.com", "acct-2": "two@example.com" },
  });
});
