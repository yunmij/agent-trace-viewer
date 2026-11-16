// server-api.test.ts — Task 5：HTTP API 接入与服务端校验。
// 临时 HOME + startServer(0) 真实随机端口 + 真实文件 fixture，无 mock。
// 注意：config.ts 在模块加载时按 os.homedir() 固化 CLAUDE_ROOT 等常量，
// 故必须在任何 src/* 导入之前设置 process.env.HOME，再走动态 import。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "atv-server-api-"));
process.env.HOME = tempHome;

const { startServer } = await import("../src/server.ts");
const { addInput, removeInput } = await import("../src/config.ts");

function writeLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj) + "\n");
}

function readLines(file: string): any[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server: http.Server = startServer(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("ephemeral port unavailable");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postJson(base: string, url: string, body: unknown): Promise<Response> {
  return fetch(base + url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("① GET /api/identity 形状正确；notes 可写入并回读，缺字段 400", async () => {
  // 临时 HOME 下放一套 codex 登录态，验证 identity 聚合读取。
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const jwtBody = Buffer.from(JSON.stringify({ email: "dev@example.com", chatgpt_account_id: "43922f38-1111-2222-3333-444444444444" })).toString("base64url");
  fs.mkdirSync(path.join(tempHome, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, ".codex", "auth.json"),
    JSON.stringify({ tokens: { id_token: `${header}.${jwtBody}.sig` } }),
  );

  await withServer(async (base) => {
    const res = await fetch(base + "/api/identity");
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok("claude" in data && "codex" in data && "notes" in data);
    assert.equal(data.codex.kind, "codex");
    assert.equal(data.codex.id, "43922f38-1111-2222-3333-444444444444");
    assert.deepEqual(data.notes, { codex: {} });

    const ok = await postJson(base, "/api/identity/notes", { accountId: "acct-1", label: "团队号" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });

    const after = await (await fetch(base + "/api/identity")).json() as any;
    assert.equal(after.notes.codex["acct-1"], "团队号");

    for (const bad of [{}, { accountId: "acct-1" }, { label: "x" }, { accountId: "", label: "x" }]) {
      const r = await postJson(base, "/api/identity/notes", bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });
});

test("② POST /api/migrate 缺 application/json → 415", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/api/migrate", {
      method: "POST",
      body: JSON.stringify({ type: "project", value: "/new/proj", targets: ["/x.jsonl"] }),
    });
    assert.equal(res.status, 415);
  });
});

test("③ target 查不到 agent / 含 :: → 400；扫描已知但 migrate 不支持的项进 result failed", async () => {
  const root = path.join(tempHome, "fixtures-3");
  fs.mkdirSync(root, { recursive: true });
  const claudeFile = path.join(root, "claude-session.jsonl");
  writeLine(claudeFile, { type: "user", cwd: "/old/proj", message: { role: "user", content: "hi" } });
  addInput(root);
  try {
    await withServer(async (base) => {
      // 不存在路径：scanSessions 结果里没有 → 400（unknown agent）。
      const r1 = await postJson(base, "/api/migrate", {
        type: "project", value: "/new/proj", targets: [path.join(root, "missing.jsonl")],
      });
      assert.equal(r1.status, 400);

      // hermes 合成引用（含 ::）→ 400。
      const r2 = await postJson(base, "/api/migrate", {
        type: "project", value: "/new/proj", targets: [path.join(root, "synthetic::ref.jsonl")],
      });
      assert.equal(r2.status, 400);

      // 非 .jsonl 不在扫描结果内 → 同样 400。
      const txt = path.join(root, "note.txt");
      fs.writeFileSync(txt, "hello");
      const r3 = await postJson(base, "/api/migrate", {
        type: "project", value: "/new/proj", targets: [txt],
      });
      assert.equal(r3.status, 400);

      // 扫描已知的 claude 文件走 account 迁移：migrate.ts 仅支持 codex，HTTP 200 且结果项 failed。
      const r4 = await postJson(base, "/api/migrate", {
        type: "account", value: "acct-B", userId: "user-B", targets: [claudeFile],
      });
      assert.equal(r4.status, 200);
      const data = await r4.json() as any;
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0].path, claudeFile);
      assert.equal(data.results[0].status, "failed");
      assert.match(data.results[0].error, /codex/);
    });
  } finally {
    removeInput(root);
  }
});

test("④ project 迁移 value 为相对路径 → 400", async () => {
  const root = path.join(tempHome, "fixtures-4");
  fs.mkdirSync(root, { recursive: true });
  const codexFile = path.join(root, "rollout-codex.jsonl");
  writeLine(codexFile, { type: "session_meta", payload: { cwd: "/old/proj" } });
  addInput(root);
  try {
    await withServer(async (base) => {
      const res = await postJson(base, "/api/migrate", {
        type: "project", value: "relative/proj", targets: [codexFile],
      });
      assert.equal(res.status, 400);

      // targets 非数组 / 空数组同样 400。
      for (const bad of [null, [], "x"]) {
        const r = await postJson(base, "/api/migrate", {
          type: "project", value: "/new/proj", targets: bad,
        });
        assert.equal(r.status, 400, JSON.stringify(bad));
      }
    });
  } finally {
    removeInput(root);
  }
});

test("⑤ happy path：codex 工程迁移成功 → 批次可查 → 回滚还原", async () => {
  const root = path.join(tempHome, "fixtures-5");
  fs.mkdirSync(root, { recursive: true });
  const codexFile = path.join(root, "rollout-happy.jsonl");
  const original = [
    { type: "session_meta", payload: { cwd: "/old/proj", runtime_workspace_roots: ["/old/proj"] } },
    { type: "turn_context", payload: { cwd: "/old/proj" } },
  ];
  fs.writeFileSync(codexFile, original.map((l) => JSON.stringify(l)).join("\n") + "\n");
  addInput(root);
  try {
    await withServer(async (base) => {
      const newValue = path.join(tempHome, "new-proj");
      const res = await postJson(base, "/api/migrate", {
        type: "project", value: newValue, targets: [codexFile],
      });
      assert.equal(res.status, 200);
      const migrated = await res.json() as any;
      assert.equal(typeof migrated.batchId, "string");
      assert.equal(migrated.results.length, 1);
      assert.equal(migrated.results[0].status, "done", migrated.results[0].error);
      assert.equal(readLines(codexFile)[0].payload.cwd, newValue);

      const listRes = await fetch(base + "/api/migrations");
      assert.equal(listRes.status, 200);
      const batches = await listRes.json() as any[];
      assert.ok(batches.some((b) => b.id === migrated.batchId), "迁移批次出现在列表中");
      assert.equal(batches.every((b) => b.type !== "rollback"), true, "默认隐藏 rollback 批次");

      const rb = await postJson(base, "/api/migrations/rollback", { id: migrated.batchId });
      assert.equal(rb.status, 200);
      const rbData = await rb.json() as any;
      assert.equal(rbData.results[0].status, "done", rbData.results[0].error);
      assert.deepEqual(readLines(codexFile), original, "回滚后内容字节语义还原");

      // 回滚产生的 rollback 安全备份批次仍不在默认列表里。
      const batchesAfter = await (await fetch(base + "/api/migrations")).json() as any[];
      assert.ok(batchesAfter.every((b) => b.type !== "rollback"));
    });
  } finally {
    removeInput(root);
  }
});

test("⑥ rollback 未知 id → 400", async () => {
  await withServer(async (base) => {
    const res = await postJson(base, "/api/migrations/rollback", { id: "no-such-batch" });
    assert.equal(res.status, 400);

    const empty = await postJson(base, "/api/migrations/rollback", {});
    assert.equal(empty.status, 400);
  });
});

test("⑧ GET /api/migrations 默认 summary 形状，?withOps=1 才带 ops 明细", async () => {
  const root = path.join(tempHome, "fixtures-8");
  fs.mkdirSync(root, { recursive: true });
  const codexFile = path.join(root, "rollout-ops.jsonl");
  writeLine(codexFile, [{ type: "session_meta", payload: { cwd: "/old/proj" } }]);
  addInput(root);
  try {
    await withServer(async (base) => {
      const mk = await postJson(base, "/api/migrate", {
        type: "project", value: path.join(tempHome, "ops-new-proj"), targets: [codexFile],
      });
      assert.equal(mk.status, 200);

      const plain = await (await fetch(base + "/api/migrations")).json() as any[];
      assert.ok(plain.length >= 1);
      assert.ok(plain.every((b) => b.ops === undefined), "默认响应不得携带 ops");

      const detailed = await (await fetch(base + "/api/migrations?withOps=1")).json() as any[];
      const mine = detailed.find((b) => b.ops && b.ops.some((op: any) => op.path === codexFile));
      assert.ok(mine, "withOps=1 响应包含本批 ops 明细");
      assert.equal(mine.ops[0].status, "done");
    });
  } finally {
    removeInput(root);
  }
});

test("⑦ 混合 agent 批次：batchIds 收集全部分组 id，results 保序，两个批次均可查可回滚", async () => {
  const root = path.join(tempHome, "fixtures-7");
  fs.mkdirSync(root, { recursive: true });
  // 额外输入源按正文检测 agent：claude 风格 user 记录 + codex 风格 session_meta。
  const claudeFile = path.join(root, "claude-mix.jsonl");
  const codexFile = path.join(root, "rollout-mix.jsonl");
  const claudeOriginal = [{ type: "user", cwd: "/old/proj", message: { role: "user", content: "hi" } }];
  const codexOriginal = [{ type: "session_meta", payload: { cwd: "/old/proj", runtime_workspace_roots: ["/old/proj"] } }];
  fs.writeFileSync(claudeFile, claudeOriginal.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(codexFile, codexOriginal.map((l) => JSON.stringify(l)).join("\n") + "\n");
  addInput(root);
  try {
    await withServer(async (base) => {
      const newValue = path.join(tempHome, "mix-new-proj");
      const targets = [claudeFile, codexFile]; // 故意 claude 在前，验证分组后 results 仍按此序
      const res = await postJson(base, "/api/migrate", { type: "project", value: newValue, targets });
      assert.equal(res.status, 200);
      const data = await res.json() as any;

      // ① 两个 agent 分组 → 两个真实批次，batchId 与 batchIds[0] 一致。
      assert.ok(Array.isArray(data.batchIds));
      assert.equal(data.batchIds.length, 2);
      assert.equal(data.batchId, data.batchIds[0]);

      // ② results 顺序与请求 targets 原始顺序一致，且全部 done。
      assert.deepEqual(data.results.map((r: any) => r.path), targets);
      assert.ok(data.results.every((r: any) => r.status === "done"), JSON.stringify(data.results));

      // claude 项发生移动，codex 项原地改写。
      const claudeResult = data.results[0];
      assert.equal(typeof claudeResult.movedTo, "string");
      assert.ok(!fs.existsSync(claudeFile), "claude 原路径已移走");
      assert.equal(readLines(codexFile)[0].payload.cwd, newValue);

      // ③ 列表能发现两个批次，id 与响应 batchIds 完全对得上。
      const batches = await (await fetch(base + "/api/migrations")).json() as any[];
      const listedIds = batches.map((b) => b.id);
      for (const id of data.batchIds) assert.ok(listedIds.includes(id), `批次 ${id} 应出现在列表中`);

      // ④ 两个批次分别回滚成功：claude 文件挪回原路径，codex 内容字节语义还原。
      for (const id of data.batchIds) {
        const rb = await postJson(base, "/api/migrations/rollback", { id });
        assert.equal(rb.status, 200);
        const rbData = await rb.json() as any;
        assert.ok(rbData.results.every((r: any) => r.status === "done"), JSON.stringify(rbData.results));
      }
      assert.ok(fs.existsSync(claudeFile), "claude 文件回滚后回到原路径");
      assert.deepEqual(readLines(claudeFile), claudeOriginal);
      assert.deepEqual(readLines(codexFile), codexOriginal);
    });
  } finally {
    removeInput(root);
  }
});
