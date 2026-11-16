// web-dom.test.ts — 在 node:vm 沙箱里加载真实的 web/trace.js + web/list.js（零依赖 stub DOM），
// 针对 XSS 转义、搜索过滤、选择集清理、批量条禁用规则、迁移请求构造、弹窗键盘门禁做断言。
// 不重写产品逻辑：所有被测函数均来自脚本本身，测试只构造 fixture 并驱动真实函数。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// ---- 最小 stub DOM：仅实现两个脚本加载与被测路径实际触达的表面 ----
class FakeClassList {
  private set = new Set<string>();
  add(c: string): void { this.set.add(c); }
  remove(c: string): void { this.set.delete(c); }
  toggle(c: string, force?: boolean): boolean {
    const on = force === undefined ? !this.set.has(c) : force;
    on ? this.set.add(c) : this.set.delete(c);
    return on;
  }
  contains(c: string): boolean { return this.set.has(c); }
}

class FakeElement {
  // 默认 hidden=true：产品里弹窗/面板初始即隐藏，任何 Modal 判定都基于显式打开。
  hidden = true;
  checked = false;
  disabled = false;
  value = "";
  textContent = "";
  className = "";
  title = "";
  innerHTML = "";
  tagName = "DIV";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  private handlers: Record<string, Array<(e?: any) => any>> = {};
  addEventListener(type: string, fn: (e?: any) => any): void {
    (this.handlers[type] ||= []).push(fn);
  }
  dispatch(type: string, ev?: any): any {
    return (this.handlers[type] || []).map((fn) => fn(ev));
  }
  // 被测路径不依赖 closest 的真实匹配；需要时由个别测试自行替换。
  closest(): FakeElement | null { return null; }
  querySelector(): FakeElement | null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  focus(): void {}
  blur(): void {}
  click(): void { this.dispatch("click"); }
  scrollIntoView(): void {}
  appendChild(): void {}
  removeChild(): void {}
}

function buildSandbox(): { ctx: any; els: Record<string, FakeElement>; docHandlers: Record<string, Array<(e?: any) => any>> } {
  const els: Record<string, FakeElement> = {};
  const docHandlers: Record<string, Array<(e?: any) => any>> = {};
  const documentStub = {
    querySelector(sel: string): FakeElement { return els[sel] ||= new FakeElement(); },
    getElementById(id: string): FakeElement { return els["#" + id] ||= new FakeElement(); },
    querySelectorAll(): FakeElement[] { return []; },
    addEventListener(type: string, fn: (e?: any) => any): void { (docHandlers[type] ||= []).push(fn); },
    documentElement: { dataset: {} as Record<string, string> },
    activeElement: null as FakeElement | null,
    body: new FakeElement(),
  };
  const storage = new Map<string, string>();
  const sandbox = {
    document: documentStub,
    window: { confirm(): boolean { return true; } },
    navigator: {},
    localStorage: {
      getItem(k: string): string | null { return storage.has(k) ? storage.get(k)! : null; },
      setItem(k: string, v: string): void { storage.set(k, v); },
      removeItem(k: string): void { storage.delete(k); },
    },
    fetch: async (): Promise<any> => ({ ok: true, json: async (): Promise<never[]> => [] }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
  };
  const ctx: any = vm.createContext(sandbox);
  const webDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../web");
  vm.runInContext(fs.readFileSync(path.join(webDir, "trace.js"), "utf8"), ctx, { filename: "web/trace.js" });
  vm.runInContext(fs.readFileSync(path.join(webDir, "list.js"), "utf8"), ctx, { filename: "web/list.js" });
  return { ctx, els, docHandlers };
}

function row(over: Record<string, any>): Record<string, any> {
  return {
    mtime: Date.now(), mtimeStr: "2026-11-16 10:00", size: 2048, lines: 10,
    agent: "codex", sessionId: "sess-" + Math.random().toString(36).slice(2, 10),
    title: "t", cwd: "/proj", path: "/tmp/x.jsonl", ...over,
  };
}

// 等加载时自动触发的 populateDirs / loadIdentity / load 尘埃落定。
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

test("esc 精确转义五个 HTML 特殊字符（XSS 防御）", () => {
  const { ctx } = buildSandbox();
  assert.equal(ctx.esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(ctx.esc("a & b"), "a &amp; b");
  assert.equal(ctx.esc(null), "");
  assert.equal(ctx.esc(undefined), "");
  assert.equal(ctx.esc(0), "0");
});

test("恶意 title / accountLabel 经 render 后在 innerHTML 中被转义", async () => {
  const { ctx, els } = buildSandbox();
  await settle();
  ctx.ALL = [row({
    title: '<img src=x onerror=alert(1)>',
    accountLabel: '"><script>alert(2)</script>',
    accountId: 'a"b',
    path: "/evil.jsonl",
  })];
  ctx.render();
  const html: string = els["#rows"].innerHTML;
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), html);
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"), html);
  assert.ok(!html.includes("<img"), "不得出现未转义 img 标签");
  assert.ok(!html.includes("<script>"), "不得出现未转义 script 标签");
});

test("match 多词 AND 过滤，跨 title/cwd/path 字段匹配", () => {
  const { ctx } = buildSandbox();
  const r = row({ title: "deploy rollout", cwd: "/Users/me/web", path: "/store/session-9.jsonl" });
  assert.equal(ctx.match(r, ""), true);
  assert.equal(ctx.match(r, "deploy web"), true);           // 两个词分别命中 title 与 cwd
  assert.equal(ctx.match(r, "session-9 rollout"), true);    // path + title
  assert.equal(ctx.match(r, "deploy missing"), false);      // AND：任一词缺失即失败
  assert.equal(ctx.match(r, "DEPLOY ROLLOUT"), true);       // 大小写不敏感
});

test("load 后已消失的 path 自动退出 picked，pickedRows 只返回存活会话", async () => {
  const { ctx } = buildSandbox();
  await settle();
  const live = row({ path: "/live/a.jsonl" });
  ctx.picked.add("/gone/stale.jsonl");
  ctx.picked.add("/live/a.jsonl");
  let calls = 0;
  ctx.fetch = async (url: string): Promise<any> => {
    calls++;
    if (url === "/api/sessions") return { ok: true, json: async () => [live] };
    return { ok: true, json: async () => [] };
  };
  await ctx.load();
  assert.equal(ctx.picked.has("/gone/stale.jsonl"), false);
  assert.equal(ctx.picked.has("/live/a.jsonl"), true);
  const rows = ctx.pickedRows();
  // vm 跨 realm 对象原型不同，不能直接 deepEqual，逐字段比较。
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "/live/a.jsonl");
  assert.ok(calls >= 1);
});

test("批量条禁用规则：hermes-only 两个按钮全禁用并给出说明", async () => {
  const { ctx, els } = buildSandbox();
  await settle();
  ctx.ALL = [row({ agent: "hermes", path: "/h1.jsonl" }), row({ agent: "hermes", path: "/h2.jsonl" })];
  ctx.picked = new Set(["/h1.jsonl", "/h2.jsonl"]);
  ctx.updateBatchBar();
  assert.equal(els["#migProj"].disabled, true);
  assert.equal(els["#migAcct"].disabled, true);
  assert.ok(els["#migProj"].title.includes("SQLite"));
  assert.ok(els["#migAcct"].title.includes("Hermes"));
});

test("批量条禁用规则：含 claude 的选择禁用账号迁移并提示仅 Codex 支持", async () => {
  const { ctx, els } = buildSandbox();
  await settle();
  ctx.ALL = [row({ agent: "claude", path: "/c.jsonl" }), row({ agent: "codex", path: "/x.jsonl" })];
  ctx.picked = new Set(["/c.jsonl", "/x.jsonl"]);
  ctx.updateBatchBar();
  assert.equal(els["#migProj"].disabled, false);
  assert.equal(els["#migAcct"].disabled, true);
  assert.ok(els["#migAcct"].title.includes("Claude"));
});

test("批量条禁用规则：codex-only 账号迁移按钮可用", async () => {
  const { ctx, els } = buildSandbox();
  await settle();
  ctx.ALL = [row({ agent: "codex", path: "/d1.jsonl" }), row({ agent: "codex", path: "/d2.jsonl" })];
  ctx.picked = new Set(["/d1.jsonl", "/d2.jsonl"]);
  ctx.updateBatchBar();
  assert.equal(els["#migProj"].disabled, false);
  assert.equal(els["#migAcct"].disabled, false);
  assert.ok(els["#migAcct"].title.includes("目标账号"));
  assert.equal(els["#batchBar"].hidden, false);
});

test("工程迁移：相对路径阻断运行；绝对路径构造正确 POST 体且 targets 保序", async () => {
  const { ctx, els } = buildSandbox();
  await settle();
  const targets = [row({ agent: "codex", path: "/s/one.jsonl" }), row({ agent: "claude", path: "/s/two.jsonl" })];
  ctx.ALL = targets;
  ctx.picked = new Set(["/s/one.jsonl", "/s/two.jsonl"]);
  const bodies: any[] = [];
  const initSeen: any[] = [];
  ctx.fetch = async (url: string, init?: any): Promise<any> => {
    if (url === "/api/migrate") { bodies.push(JSON.parse(init.body)); initSeen.push(init); }
    if (url === "/api/sessions") return { ok: true, json: async () => targets };
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };

  // 相对路径（手动输入）必须被拦截
  ctx.openMigrate("project");
  els["#migTarget"].value = ctx.MANUAL;
  els["#migCustom"].value = "relative/proj";
  els["#migRun"].dispatch("click");
  await settle();
  assert.equal(els["#migMsg"].textContent, "工程目标必须是绝对路径");
  assert.equal(bodies.length, 0);

  // 绝对路径放行，校验方法 / content-type / JSON 体
  els["#migCustom"].value = "/Users/me/new-proj";
  els["#migRun"].dispatch("click");
  await settle();
  assert.equal(bodies.length, 1);
  assert.equal(initSeen[0].method, "POST");
  assert.equal(initSeen[0].headers["content-type"], "application/json");
  assert.deepEqual(bodies[0], {
    type: "project",
    value: "/Users/me/new-proj",
    targets: ["/s/one.jsonl", "/s/two.jsonl"],
  });
});

test("账号迁移：缺 creator_user_id 阻断；补齐后 userId 进入 POST 体", async () => {
  const { ctx, els } = buildSandbox();
  await settle();
  ctx.ALL = [row({ agent: "codex", path: "/s/c.jsonl", accountId: "acct-old" })];
  ctx.picked = new Set(["/s/c.jsonl"]);
  const bodies: any[] = [];
  const only = ctx.ALL;
  ctx.fetch = async (url: string, init?: any): Promise<any> => {
    if (url === "/api/migrate") bodies.push(JSON.parse(init.body));
    if (url === "/api/sessions") return { ok: true, json: async () => only };
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };

  ctx.openMigrate("account");
  els["#migTarget"].value = ctx.MANUAL;
  els["#migCustom"].value = "acct-new";
  els["#migUserId"].value = "";
  els["#migRun"].dispatch("click");
  await settle();
  assert.equal(els["#migMsg"].textContent, "账号迁移必须填写 creator_user_id");
  assert.equal(bodies.length, 0);

  els["#migUserId"].value = "user-42";
  els["#migRun"].dispatch("click");
  await settle();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], {
    type: "account",
    value: "acct-new",
    targets: ["/s/c.jsonl"],
    userId: "user-42",
  });
});

test("anyModalOpen 反映真实弹窗 hidden 状态，keydown 守卫据此让位并处理 Escape", async () => {
  const env = buildSandbox();
  await settle();
  const { ctx, els, docHandlers } = env;
  assert.equal(ctx.anyModalOpen(), false);

  els["#migrateModal"].hidden = false;
  assert.equal(ctx.anyModalOpen(), true);
  els["#migrateModal"].hidden = true;
  assert.equal(ctx.anyModalOpen(), false);

  els["#noteModal"].hidden = false;
  assert.equal(ctx.anyModalOpen(), true);

  // 弹窗开启时按 Escape：两个弹窗都被关闭（产品 keydown 守卫的真实行为）
  els["#noteModal"].hidden = true;
  els["#migrateModal"].hidden = false;
  docHandlers.keydown[0]({ key: "Escape", preventDefault(): void {} });
  assert.equal(els["#migrateModal"].hidden, true);
  assert.equal(els["#noteModal"].hidden, true);
});
