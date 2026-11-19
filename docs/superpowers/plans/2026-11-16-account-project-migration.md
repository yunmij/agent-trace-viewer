# 账户/工程展示 与 会话迁移 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 agent-trace-viewer 增加 session 账户/工程信息展示，以及带自动备份与回滚的批量会话迁移（工程 / 账号）能力。

**Architecture:** 新增两个零依赖后端模块：`src/identity.ts`（从各 agent 本机凭据/会话读取账户身份）与 `src/migrate.ts`（备份、JSONL 定点改写、原子 rename、manifest、sha256 漂移检测、回滚）；`src/scan.ts` 在现有前 N 条解析中顺带抽取 Codex 账号字段；`src/server.ts` 增加 4 组 JSON API；前端 `web/list.js` 增加复选框、批量条、迁移弹窗与迁移记录面板。

**Tech Stack:** TypeScript（Node ≥18 运行，dev Node ≥22.18 type stripping）、零运行时依赖、Node 内置 `node:test`/`node:assert`/`node:crypto`、原生浏览器 JS/CSS。

**Spec:** `docs/superpowers/specs/2026-11-16-account-project-migration-design.md`

## Global Constraints

- 零运行时依赖：只用 Node 内置模块（JWT 解码用 `Buffer.from(s, "base64url")`，哈希用 `node:crypto`），禁止新增 npm 依赖。
- 测试框架：`node:test` + `node:assert`（内置）；测试文件放 `test/`，TS 编写，靠 Node 22.18+ type stripping 直接跑。
- 写操作只碰 `.jsonl` 会话文件与 `~/.agent-trace-viewer/`（demo 模式下随 `HOME` 重定向到 `.demo-home`，一律用 `os.homedir()`，不硬编码 `/Users`）。
- 迁移改写语义：只改归属元数据（Claude 第一条带 `cwd` 的记录；Codex 首条 `session_meta`；OpenClaw 唯一顶层 `session.cwd`），逐轮历史 cwd 与内嵌祖先 meta 一律不动。
- 所有 JSON 写接口保持现有防护：仅接受 `application/json`，复用 Host 头校验。
- 提交信息使用中文；每个 Task 结束时提交。
- 每个 Task 完成后跑 `npm run typecheck`，必须通过。

## Review Focus

1. **损坏的 JSONL 行**：含无法 `JSON.parse` 的行时，改写必须原样保留该行、不丢数据、其余行正常改写 —— Task 3 测试覆盖。
2. **目标文件同名冲突**：Claude 工程迁移目标路径已存在同名文件时中止该项且绝不覆盖 —— Task 3 测试覆盖。
3. **回滚漂移**：同一文件连续迁移两次后回滚第一批，必须因 sha256 不匹配整批中止并报告冲突项 —— Task 4 测试覆盖。
4. **非法 target 拒绝**：路径穿越（`../`）、非 `.jsonl`、Hermes 的 `::` 合成 ref、不存在的文件一律 400；Claude 工程迁移落点必须在 `CLAUDE_ROOT` 内 —— Task 5 测试覆盖。
5. **凭据文件缺失/损坏**：`~/.claude/.credentials.json`、`~/.codex/auth.json` 不存在或 JSON 损坏时，身份接口降级返回「未知」而不是抛错，扫描不中断 —— Task 1 测试覆盖。

---

### Task 1: 测试脚手架 + `src/identity.ts` 账户身份模块

**Files:**
- Create: `src/identity.ts`
- Create: `test/identity.test.ts`
- Modify: `package.json`（新增 `"test": "node --test test/"` 脚本，放在 `scripts` 内）

**Interfaces:**
- Produces:
  - `interface AccountInfo { kind: "claude" | "codex"; id: string; label: string; email?: string }`
  - `getClaudeIdentity(homeDir?: string): AccountInfo | null` —— 默认 `os.homedir()`；读 `<home>/.claude/.credentials.json` 的 `claudeAiOauth.subscriptionType` 与 `<home>/.claude.json` 的 `userID`；label = `${subscriptionType} · ${userID.slice(0,8)}`，id = userID 前 8 位。
  - `getCodexAuthIdentity(homeDir?: string): AccountInfo | null` —— 读 `<home>/.codex/auth.json`，base64url 解 `tokens.id_token` 的 payload，取 `email` 与 `chatgpt_account_id`；label = email，id = chatgpt_account_id，kind = "codex"。
  - `readAccountNotes(homeDir?: string): { codex: Record<string, string> }` —— 读 `<home>/.agent-trace-viewer/accounts.json`；文件不存在返回 `{ codex: {} }`。
  - `saveAccountNote(accountId: string, label: string, homeDir?: string): void` ——  mkdir 后写回，JSON 两空格缩进。
  - `decodeJwtPayload(token: string): Record<string, unknown>` —— 纯函数，不验签；段数不为 3 时抛 `Error("invalid jwt")`。
  - 所有函数对文件读取/JSON 解析失败静默降级（返回 null 或空对象），唯独 `decodeJwtPayload` 对格式错误抛异常。

- [ ] **Step 1: 写失败测试 `test/identity.test.ts`**

用 `fs.mkdtempSync(path.join(os.tmpdir(), "atv-"))` 造临时 HOME，测：① 两个凭据文件齐全时 claude identity 的 label/id 正确（fixture：subscriptionType `team`、userID 20 位哈希，断言前 8 位）；② codex JWT 用 node 自己拼一个 header/payload（payload 含 `email`、`chatgpt_account_id`）签名段随意，断言解出的 label=email、id=account id；③ 凭据文件全缺时两个 getter 返回 null 且不抛；④ 写入损坏 JSON 时返回 null 不抛；⑤ `decodeJwtPayload("not-a-jwt")` 抛 `invalid jwt`；⑥ `saveAccountNote` 后 `readAccountNotes` 能读回，且文件落在 `<home>/.agent-trace-viewer/accounts.json`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `src/identity.ts`**

按上面的接口实现；文件读取统一 try/catch 降级；`decodeJwtPayload` 用 `Buffer.from(part, "base64url")`。

- [ ] **Step 4: 跑测试与 typecheck**

Run: `npm test && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 5: 提交**

`git add src/identity.ts test/identity.test.ts package.json && git commit -m "feat: 新增账户身份读取模块与测试脚手架"`

---

### Task 2: 扫描链路接入账户字段与工程聚合数据

**Files:**
- Modify: `src/types.ts`（SessionRow 扩展、StructMeta 扩展）
- Modify: `src/scan.ts`（`structMetaFromRecords` 抽取 codex 账号；`scanSessions` 挂账户标签）
- Modify: `src/parse-hermes.ts`（无需改逻辑，确认 Hermes 行新字段为 undefined 即可）
- Create: `test/scan-account.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `getClaudeIdentity`、`getCodexAuthIdentity`、`readAccountNotes`。
- Produces:
  - `StructMeta` 增加 `accountId?: string; accountUserId?: string`（仅 codex 首条 `session_meta.payload` 的 `creator_account_id` / `creator_user_id`）。
  - `SessionRow` 增加 `accountId?: string; accountLabel?: string`。
  - `structMetaFromRecords` 内：遇首条 `r.type === "session_meta"` 时，从 `r.payload` 取两个 creator 字段（仅首次赋值，后续内嵌 meta 忽略）。
  - 标签解析规则（scanSessions 内小helper `codexAccountLabel(id, notes, auth)`）：id === auth.id → auth.label（邮箱）；notes.codex[id] 存在 → 备注；否则 `account-${id.slice(0,8)}`。
  - claude 行：`getClaudeIdentity()` 非 null 时统一挂 `accountId = identity.id`、`accountLabel = identity.label`；null 时两字段留空。
  - openclaw / hermes 行：两字段留空。

- [ ] **Step 1: 写失败测试 `test/scan-account.test.ts`**

临时目录造三组 fixture：① codex jsonl，首条 session_meta 带固定 creator_account_id `43922f38-...` + 第二条内嵌 session_meta 带**不同** id，断言 StructMeta 只取首条；② claude jsonl（含 cwd 行），配合临时 HOME 下的 `.claude/.credentials.json` + `.claude.json`，断言 scanSessions 行带 claude 账户标签；③ openclaw jsonl 断言两账户字段为 undefined。临时 HOME 通过给 identity 函数传参实现（scan 侧用可选 homeDir 参数透传：`scanSessions(homeDir?: string)`，默认 `os.homedir()`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/scan-account.test.ts`
Expected: FAIL（字段 undefined）。

- [ ] **Step 3: 改 `src/types.ts` 与 `src/scan.ts`**

按接口扩展类型；`scanSessions(homeDir = os.homedir())` 内取一次 identity/notes 复用，避免逐行读文件；fileMeta 缓存结构不动（StructMeta 多两字段自动随缓存）。

- [ ] **Step 4: 跑全量测试与 typecheck**

Run: `npm test && npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

`git commit -m "feat: 会话扫描接入账户字段与标签解析"`

---

### Task 3: `src/migrate.ts` 核心——备份、定点改写、工程迁移

**Files:**
- Create: `src/migrate.ts`
- Create: `test/migrate.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_ROOT`（从 config.ts 导入，允许测试时通过 opts 覆盖）。
- Produces:
  - `type Change = { field: string; from: string; to: string }`
  - `type OpResult = { path: string; status: "done" | "failed"; error?: string; movedTo?: string; changes: Change[]; postHash?: string }`
  - `interface MigrateOpts { type: "project" | "account"; value: string; userId?: string; allowedRoots: string[]; claudeRoot: string; backupRoot: string }`
  - `interface MigrateResult { batchId: string; results: OpResult[] }`
  - `migrateSessions(targets: string[], opts: MigrateOpts): MigrateResult`
  - 内部但导出供测试：`rewriteJsonlAtomic(file: string, mapRecord: (rec: Rec, idx: number) => Rec | null): { changed: boolean; changes: Change[] }` —— mapRecord 返回 null 表示该行不改；解析失败的行原样字符串回写；临时文件同目录 `.migrate-<随机>` + `fs.renameSync` 覆盖。
  - `encodeClaudeProject(cwd: string): string` —— 纯函数：`cwd.split("/").join("-")`（前导 `/` 自然变前导 `-`，与现有布局一致）。
  - 备份：每批次 `backupRoot/<yyyyMMdd-HHmmss>-<6位随机>/`，文件按去掉前导 `/` 的原路径结构存放；同目录写 `manifest.json`（结构见 spec 5.4，含 `postHash` sha256 hex）。
  - 本 Task 只实现 `type: "project"`；`type: "account"` 在 Task 4 接入，本 Task 遇到 account 类型抛 `Error("not implemented")`。
  - 三种 agent 的 project 改写映射（agent 由调用方在 server 侧判定后传入；migrate 侧用 opts 增加 `agent: "claude" | "codex" | "openclaw"` 字段，加进 MigrateOpts）：
    - claude：第一条含字符串 `cwd` 的记录替换该字段；文件移动到 `<claudeRoot>/<encodeClaudeProject(value)>/<原文件名>`，目标目录 `mkdirSync(recursive)`；同名存在 → failed 不覆盖。
    - codex：首条 `type==="session_meta"` 的 payload：`cwd` 改新值；`runtime_workspace_roots` 数组中等于旧 cwd 的元素替换；不挪文件。
    - openclaw：第一条含顶层字符串 `cwd` 的记录替换；不挪文件。
  - 每个 target 先 `fs.statSync` 校验：必须是 `.jsonl` 普通文件、真实路径前缀命中 `allowedRoots` 之一；hermes ref（含 `::`）直接 failed。
  - 批次语义：先逐项备份再逐项执行；单项失败不影响其余；全部结果（含 failed）写 manifest。

- [ ] **Step 1: 写失败测试 `test/migrate.test.ts`**

mkdtemp 造完整沙箱（假 claudeRoot、backupRoot、allowedRoots、各 agent fixture 文件）。用例：① claude 工程迁移：文件出现在新编码目录、原路径消失、新文件**仅第一条** cwd 被改、后续 cwd 行保留旧值；② codex：只首条 session_meta 的 cwd 与 workspace_roots 被改，构造 `turn_context`/第二条内嵌 meta 断言它们不变；③ openclaw：唯一 session.cwd 被改；④ 损坏行 fixture（中间插一行 `{bad json`）断言该行原样存在且迁移成功；⑤ 目标同名文件预先创建 → 该项 status=failed 且预置文件内容不变；⑥ 备份目录存在原文件副本且 manifest.json 可解析、含 postHash；⑦ postHash 与迁移后文件实际 sha256 一致；⑧ 非 `.jsonl` 与含 `::` 的 target 返回 failed。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/migrate.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/migrate.ts`**

按接口实现；sha256 用 `crypto.createHash("sha256")`；JSONL 回写保持每行一个 JSON + 末尾 `\n`；备份在任何改写/移动之前完成。

- [ ] **Step 4: 跑全量测试与 typecheck**

Run: `npm test && npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

`git commit -m "feat: 实现会话工程迁移与备份机制"`

---

### Task 4: 账号迁移、批次查询与漂移检测回滚

**Files:**
- Modify: `src/migrate.ts`
- Modify: `test/migrate.test.ts`

**Interfaces:**
- Produces:
  - `migrateSessions` 支持 `type: "account"`：仅接受 `agent: "codex"`；改首条 session_meta 的 `creator_account_id`（opts.value）与 `creator_user_id`（opts.userId，必填，缺失直接该项 failed）；内嵌后续 meta 不动。
  - `listBatches(backupRoot: string): Array<{ id: string; type: string; createdAt: string; opCount: number; doneCount: number }>` —— 读 backupRoot 下各子目录 manifest，按时间倒序。
  - `readBatch(batchId: string, backupRoot: string): Manifest` —— 防 `../` 穿越：basename 校验后拼接，解析后返回。
  - `rollbackBatch(batchId: string, backupRoot: string): MigrateResult` —— ① readBatch；② 漂移检测：逐项算当前文件（有 movedTo 取 movedTo，否则 path）sha256 与 postHash 比对，任一不匹配或文件缺失 → 整批中止，返回的 result 中冲突项带 error，不执行任何还原；③ 通过后先做 `rollback-<batchId>/` 安全备份（同结构 + 自己的 manifest）；④ 反向执行：移动过的挪回原路径（原路径被占用则该项 failed），其余用备份覆盖。

- [ ] **Step 1: 追加失败测试**

用例：① codex 账号迁移后首条 meta 两个 creator 字段更新、第二条内嵌 meta 保持旧 id；② 缺 userId 时该项 failed 且文件内容不变；③ 连续两次迁移 A→B→C 后回滚第一批：断言整批中止、结果含漂移 error、磁盘文件保持 C 状态；④ 未被二次改动的正常批次回滚：文件内容/路径还原成最初状态，且 `rollback-*` 目录存在；⑤ `readBatch("../etc")` 抛错或返回错误不穿越；⑥ listBatches 顺序与计数正确。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/migrate.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现账号迁移与回滚**

复用 Task 3 的 `rewriteJsonlAtomic` 与备份工具，不新写文件操作原语。

- [ ] **Step 4: 全量测试 + typecheck**

Run: `npm test && npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

`git commit -m "feat: 实现账号迁移、批次查询与带漂移检测的回滚"`

---

### Task 5: HTTP API 接入与服务端校验

**Files:**
- Modify: `src/server.ts`
- Create: `test/server-api.test.ts`

**Interfaces:**
- Consumes: Task 1/2/3/4 全部导出；`allInputs()` 作为 allowedRoots、`CLAUDE_ROOT` 作为 claudeRoot、`<homedir>/.agent-trace-viewer/backups` 作为 backupRoot。
- Produces（路由，均复用现有 `sendJson`/`readJson`/host 校验）：
  - `GET /api/identity` → `{ claude: AccountInfo | null, codex: AccountInfo | null, notes: { codex: Record<string,string> } }`
  - `POST /api/identity/notes` body `{ accountId: string, label: string }` → `{ ok: true }`；缺字段 400。
  - `POST /api/migrate` body `{ type, value, userId?, targets: string[] }` → MigrateResult；targets 非数组/为空 400；agent 按现有 scanSessions 结果的 path→agent 映射判定，查不到 400；hermes 项 400。
  - `GET /api/migrations` → listBatches 结果。
  - `POST /api/migrations/rollback` body `{ id: string }` → MigrateResult；未知 id 400。
  - 所有 POST 保持 `application/json` 校验（与 /api/inputs 同一段逻辑风格）。
  - 工程迁移 value 必须是 `path.isAbsolute` 的规范化路径，否则 400；claude 的最终落点由 migrate.ts 拼在 CLAUDE_ROOT 内，server 不额外拼接。

- [ ] **Step 1: 写失败测试 `test/server-api.test.ts`**

`startServer(0)` 拿随机端口（导出的函数已返回 server 实例，测后 `server.close()`），用临时 HOME 与 fetch 调用。用例：① GET identity 形状正确；② POST migrate 缺 content-type → 415；③ target 为不存在路径 / 非 jsonl / 含 `::` → 400 或结果内 failed（按接口定义：查不到 agent 400，其余进 result failed）；④ 工程 value 传相对路径 → 400；⑤ 完整 happy path：造 codex fixture 加到 extra input（addInput），POST project 迁移成功且 GET /api/migrations 能查到批次，再 POST rollback 还原；⑥ rollback 未知 id → 400。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/server-api.test.ts`
Expected: 路由 404，FAIL。

- [ ] **Step 3: 改 `src/server.ts`**

路由集中加在现有 /api/inputs 分支之后；agent 映射从一次 `scanSessions()` 构建 `Map<path, agent>`。

- [ ] **Step 4: 全量测试 + typecheck**

Run: `npm test && npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 5: 手动冒烟**

Run: `npm run demo`，浏览器开 http://127.0.0.1:8787，确认列表正常、`curl http://127.0.0.1:8787/api/identity` 返回 JSON。

- [ ] **Step 6: 提交**

`git commit -m "feat: 接入账户与迁移相关 HTTP API"`

---

### Task 6: 前端——账户/工程展示、批量选择、迁移弹窗与记录面板

**Files:**
- Modify: `src/pages.ts`（LIST_PAGE 增加：工程筛选 select#proj、行复选框容器、底部批量条 #batchBar、迁移弹窗 #migrateModal、迁移记录面板 #migPanel；图标 symbol 补两个：迁移/历史）
- Modify: `web/list.js`
- Modify: `web/trace.css`
- Modify: `web/trace.js`（详情头部加账户徽章 + 完整 cwd 行，数据取自 /api/sessions 已有的行字段；trace.js 内现有 render 流程找到 header 注入点即可）

**Interfaces（前端内部约定，无新后端契约）：**
- 列表行 meta 增加账户徽章 `<span class="acct">`（accountLabel 为空则不渲染）；工程筛选选项从 ALL 的 cwd 去重聚合（值为 cwd 全路径），与现有 #dir 源筛选并列、AND 组合。
- 复选框：行首 `<input type="checkbox" class="pick" data-path=...>`；选中集合存 `Set`，批量条显示数量；批量条按钮：迁移到工程 / 迁移到账号（选择集含不支持的 agent 时禁用并 title 说明：claude→账号禁用、hermes→两者禁用）。
- 弹窗：目标 select（工程模式=已知 cwd 列表 + 手输 option；账号模式=/api/identity 返回的账号 + 历史账号备注列表）；改动明细表（session 标题、agent、字段前后值，由前端按选中行预估）；确认勾选框 + 执行按钮；POST /api/migrate 后 toast 成功/失败数、清空选择、`load()` 刷新。
- 迁移记录面板：顶栏新增历史图标按钮，GET /api/migrations 渲染批次列表，可展开（GET 不需要单批详情，列表接口若信息不足则在 listBatches 返回里带 changes 摘要——实现时若需要，给 listBatches 每项加 `ops: OpResult[]` 透传，属于本 Task 内允许的后端小调整，同步补一个测试断言），每批次一个「回滚」按钮调 /api/migrations/rollback；漂移中止时展示返回的 error。
- 备注入口：账号筛选区每个未知账号旁一个「备注」小按钮，弹窗输入后调 /api/identity/notes 并刷新。
- 保持现有键盘导航：j/k 打开行的行为不变，复选框点击 stopPropagation 不触发 openRow。

- [ ] **Step 1: 改 `src/pages.ts` 骨架**

加入上述容器元素与两个 SVG symbol；不动现有元素 id。

- [ ] **Step 2: 实现 `web/list.js` 交互**

按约定逐块实现：账户徽章与工程筛选 → 复选框与批量条 → 迁移弹窗 → 记录面板 → 备注。

- [ ] **Step 3: 补 `web/trace.css` 样式**

复用现有 CSS 变量与明暗主题；批量条 position:sticky 底部；弹窗用现有 .panel 同款风格。

- [ ] **Step 4: 详情头部（`web/trace.js`）**

注入账户徽章与完整 cwd（可复制）；无账户字段时不渲染。

- [ ] **Step 5: typecheck + 手动验证清单**

Run: `npm run typecheck && npm run demo`
浏览器逐项验收：账户徽章/筛选、工程筛选、多选批量条禁用逻辑、工程迁移弹窗全流程（demo HOME 内执行，确认 .demo-home/.agent-trace-viewer/backups 生成）、回滚、备注、明暗主题、移动端窄宽度无横向滚动、`/` 与 j/k 键盘行为不回退。

- [ ] **Step 6: 提交**

`git commit -m "feat: 前端支持账户工程展示、批量迁移与回滚面板"`

---

### Task 7: Demo 数据、文档与发布说明

**Files:**
- Modify: `scripts/make-demo.mjs`
- Modify: `README.md`、`README.zh-CN.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: demo 数据补字段**

codex fixture 的 session_meta.payload 补 `creator_account_id` / `creator_user_id`（两个不同账号各造至少一条，体现历史账号场景）；demo HOME 下写 `.codex/auth.json`（JWT payload 含 email + 匹配其中一个 account 的 chatgpt_account_id）与 `.claude/.credentials.json`（claudeAiOauth.subscriptionType）+ `.claude.json`（userID）。跑 `npm run demo` 验证两个 agent 的账户徽章都出现。

- [ ] **Step 2: 更新 README（中英双语）**

Features 表加两行（账户/工程展示、批量迁移带备份回滚）；HTTP API 表加 4 个端点；Security 章节把「Read-only」改写为「默认只读；迁移类写操作仅限会话 .jsonl，自动备份到 ~/.agent-trace-viewer/backups 且可回滚」；Supported agents 表的 Notes 补账户能力差异（Hermes 只读不可迁移、Claude 无账号迁移）。

- [ ] **Step 3: CHANGELOG 加条目**

按现有文件风格写 Unreleased 条目，列主要新增点。

- [ ] **Step 4: 全量验证**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全通过，dist 产出正常。

- [ ] **Step 5: 提交**

`git commit -m "docs: 补充账户迁移功能文档并完善 demo 数据"`

---

## 自检结论

- **Spec 覆盖**：身份展示（T1/T2/T6）、工程聚合筛选（T2/T6）、工程迁移三 agent 语义（T3）、账号迁移（T4）、备份/manifest/postHash（T3）、漂移回滚（T4）、API 与防护（T5）、前端批量交互（T6）、demo/文档/read-only 表述更新（T7）—— spec 各节均有归属任务；spec 第 7 节已知边界（trajectory 不动、archived_sessions 不纳入、归属/历史分离、Claude 无账号迁移）分别由 T3 不实现 trajectory 处理、T5 扫描范围不变、T3/T4 定点改写测试、T6 禁用逻辑保证。
- **类型一致性**：`MigrateOpts`、`OpResult`、`AccountInfo`、`StructMeta/SessionRow` 新字段在各任务接口块中同名同义；`scanSessions(homeDir?)` 的可选参数从 T2 引入并被 T5 沿用。
- **不可测部分**：纯前端 Task 6 无浏览器自动化（项目零依赖约束），以 typecheck + demo 手动验收清单兜底；后端全部逻辑有 node:test 覆盖。
