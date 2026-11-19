# 账户/工程信息展示 与 会话迁移能力 设计文档

日期：2026-11-16
状态：待批准

## 1. 意图与背景

agent-trace-viewer 目前把本机各 agent（Claude Code / Codex / OpenClaw / Hermes）的会话聚合成一个只读浏览列表，每行展示标题、工程目录名、时间、大小，但：

1. 看不到会话归属的**账户**信息，多账号场景下无法区分会话来源；
2. 工程目录只有名称、没有按工程聚合筛选，信息利用不充分；
3. 完全只读，无法在工具内整理会话——用户需要把会话**迁移到另一个工程或另一个账号下**，且需要批量操作。

目标：在保持本地优先、零依赖、默认只读的产品基调下，增加账户/工程展示与带备份、可回滚的批量迁移能力。

## 2. 目标、非目标、反目标

### 目标

- 列表与详情展示每个 session 的账户信息与完整工程目录，支持按账户、按工程筛选。
- 支持勾选多个 session，批量迁移到指定工程或指定账号。
- 所有写操作自动备份、可一键回滚；迁移明细对用户完全透明。
- 按各 agent 的真实数据能力分别实现，不无中生有造字段。

### 非目标

- 不做跨机器迁移、不做实时文件监听、不做云同步。
- 不读取或展示任何 token / refreshToken 原文。
- 不修改各 agent 的凭据文件（`~/.codex/auth.json`、`~/.claude/.credentials.json` 等）。
- Hermes（SQLite 存储）不做任何写操作，只做只读展示。

### 反目标

- 为了凑齐四 agent 功能矩阵而伪造账户概念（OpenClaw/Hermes 没有就明确不显示）。
- 迁移不可恢复、静默覆盖已有文件。
- 把工具变成一个需要账号登录的服务——账户指的是各 agent CLI 自身的登录身份，不是本工具的账号体系。

## 3. 现状与关键事实（已在本机核实）

| 事实 | 来源 |
|---|---|
| Claude session 的 `cwd` 是逐行字段，实测 167 行中 108 行带 `cwd`；无任何账户字段 | `~/.claude/projects/**/*.jsonl` |
| Claude 全机一份登录态：`.credentials.json`（含 subscriptionType，实测 `team`）、`.claude.json`（含 userID，哈希），本地均无邮箱 | 同上目录上层 |
| Codex 每条 session 首条 `session_meta.payload` 含 `creator_account_id`、`creator_user_id`、`cwd`、`runtime_workspace_roots[]`；实测 149 条全部同一账号 | `~/.codex/sessions/**/rollout-*.jsonl` |
| Codex 当前账号邮箱可从 `~/.codex/auth.json` 的 `tokens.id_token`（JWT，不验签只 base64 解码 payload）取 `email` claim | 同上 |
| OpenClaw 记录内含 `cwd` / `workspaceDir`，无账户字段；目录按 agent 名（如 `main`）分区 | `~/.openclaw/agents/<agent>/sessions/*.jsonl` |
| Hermes 会话在 SQLite `~/.hermes/state.db`，无账户概念 | parse-hermes.ts |
| 现有写操作先例：`/api/inputs` 的 POST 仅接受 `application/json`，用于跨站防护 | server.ts |
| Claude 工程目录名是 cwd 的路径编码：`/` → `-`（如 `/Users/x/a-b` → `-Users-x-a-b`），与现有 `~/.claude/projects` 布局一致 | 目录 listing |

## 4. 方案选型（Approaches）

### 4.1 「账号」的语义

| 方案 | 说明 | 取舍 | 结论 |
|---|---|---|---|
| A. 应用层逻辑标签 | 工具自维护一份 session→自定义账号名的元数据 | 最灵活但与 agent 真实身份脱节，迁移结果 agent 自身不识别，用户明确要求「按不同 agent 做对应处理，没有就不展示」 | 否决 |
| B. 多套 home/config 根目录 | 迁移 = 文件在多个配置根之间物理移动 | 仅适合显式维护多套 HOME 的用户，本机不存在该布局 | 否决 |
| C. 各 agent 原生字段分别处理 | Codex 用 `creator_account_id` 原生字段；Claude 展示公共登录态、不支持账号迁移；无账户概念的 agent 不显示 | 完全贴合磁盘真实数据，迁移语义可解释 | **采用** |

### 4.2 写操作安全策略

| 方案 | 取舍 | 结论 |
|---|---|---|
| 自动备份 + 可回滚 | 占少量磁盘，误操作可恢复，用户已选 | **采用** |
| 仅二次确认 | 误操作不可逆 | 否决 |
| 只做 dry-run 输出脚本 | 安全但用户还要自己执行，批量场景体验差 | 否决 |

### 4.3 迁移执行方式

原地逐行改写（临时文件 + 原子 rename），而不是「复制到新文件再删旧的」两步法——后者在中断时会留下双份会话。原子 rename 保证任一时刻磁盘上至多一份有效文件。

## 5. 详细设计

### 5.1 账户信息展示

新增 `src/identity.ts`，负责账户身份的读取与映射：

- `getClaudeIdentity()`：读 `~/.claude/.credentials.json` 的 `claudeAiOauth.subscriptionType`（实测嵌套在 `claudeAiOauth` 下）与 `~/.claude.json` 的 `userID`，返回如 `{ id: userID前8位, label: "team · 9557a376", kind: "claude" }`；文件缺失时返回 null。读取失败一律降级为「未知」，不阻断扫描。
- `getCodexIdentityMap()`：
  - 从 `~/.codex/auth.json` JWT 解出当前账号：`email` claim 作显示名，`chatgpt_account_id` claim 直接与 session 的 `creator_account_id` 匹配（无需猜测映射）；
  - 扫描时从各 session 的首条 `session_meta` 收集全部 `creator_account_id`；
  - 命中当前账号的 ID 显示邮箱；历史账号显示 `account-<id前8位>`；
  - 用户可在 UI 给历史账号补备注，存 `~/.agent-trace-viewer/accounts.json`（结构 `{ codex: { [accountId]: label } }`，纯本地、手工创建目录）。
- SessionRow 扩展字段：`accountId?: string`、`accountLabel?: string`。Codex 在 `structMetaFromRecords` 同一次前 N 条解析里顺带取出 account 字段，不新增文件读取；Claude 行在 scanSessions 里统一挂公共身份；OpenClaw/Hermes 字段留空，前端不渲染账户列内容。
- 前端：列表 meta 行加账户徽章；agent 药丸旁新增账户筛选（仅对有账户概念的 agent 出现）；trace 详情头部展示账户与完整 cwd。

### 5.2 工程目录增强

- SessionRow 已有 `cwd`，新增按 cwd 聚合的「工程」筛选下拉（与现有「输入源」下拉并列；数据源是扫描结果而非文件系统）。
- 列表行工程名 hover 展示全路径（现状已有 title），详情页头部新增一行完整 cwd，点击可复制。
- cwd 为空（异常旧数据）时显示 `(unknown)` 且不可作为迁移目标。

### 5.3 迁移能力

#### UI 交互

- 每行左侧加复选框；选中后页面底部浮现批量操作条，显示已选数量与两个按钮：**迁移到工程…**、**迁移到账号…**（按所选 session 的 agent 能力自动禁用不可用项，禁用时 hover 说明原因，如「Claude 只有一个账号」「Hermes 会话不支持迁移」）。
- 弹窗：目标从已知 cwd / 已知账号列表选择，也可手输新工程绝对路径；下方列出改动明细表（session 标题、agent、字段前后值、文件是否移动）；点「执行」前需勾选「我知道这会修改磁盘上的会话文件」确认框。
- 执行后 toast 展示成功/失败数，自动刷新列表；失败明细可展开。

#### 后端语义

新增 `src/migrate.ts`，统一入口 `migrateSessions(targets: string[], opts: { type: "project" | "account"; value: string })`，返回逐项结果。

**迁移到工程（project）——只改归属元数据，不重写逐轮历史（用户已确认）：**

跨 agent 统一原则：只改 `structMetaFromRecords` 实际读取的归属字段（首个 cwd / 首条 `session_meta`），文件内 turn_context、event_msg、后续记录中逐轮产生的 cwd 是用户中途 `cd` 的真实历史，一律保留不动。

| Agent | 动作 |
|---|---|
| claude | 目标目录 `~/.claude/projects/<encode(cwd)>/`（编码规则与现有布局一致，不存在则 `fs.mkdir` 递归创建）；文件 `fs.rename` 移入；随后只改写**第一条带 `cwd` 字段的记录**（即归属记录），其余 107/167 这类逐行 cwd 保留原值 |
| codex | 文件位置不含工程信息，不挪文件；只改**首条** `session_meta.payload.cwd` 与同条的 `runtime_workspace_roots[]`（数组内每个等于旧 cwd 的元素替换，其余保留）。后续内嵌的父/恢复会话 meta（实测 122/149 文件含多条）、turn_context、event_msg、world_state 中的 cwd 全部不动 |
| openclaw | plain 会话文件只有唯一一条顶层 `session.cwd`，定点改写该字段即可。同目录 `.trajectory.jsonl` 兄弟文件**不动**（viewer 本就去重过滤它），本文档第 8 节注明该边界 |
| hermes | 拒绝，返回 `unsupported: hermes is SQLite-backed` |

**迁移到账号（account）：**

| Agent | 动作 |
|---|---|
| codex | 只改**首条** `session_meta.payload.creator_account_id` 与 `creator_user_id`；内嵌祖先 meta 的 creator 字段保留旧值。目标账号从 identity map 选择（含已备注的历史账号），手输时必须同时给 account_id 与 user_id 两个值并二次提示 |
| claude / openclaw / hermes | 拒绝，返回能力说明 |

**通用规则：**

- 改写 JSONL：逐行 `JSON.parse`，仅命中归属字段的行做定点修改后 `JSON.stringify`，其余行原样回写（保持每行一个 JSON、`\n` 结尾）；解析失败的行原样保留并计数返回（不丢数据）。
- 先写同目录临时文件（`.migrate-<随机后缀>`），fsync 后 `fs.rename` 原子覆盖。
- 移动文件时目标路径已存在同名文件 → 该项中止报错，绝不覆盖。
- 单次批次内先全部备份、再逐项执行；某项失败不影响其余项，结果逐项汇报。
- 迁移前校验所有目标路径：工程路径必须是绝对路径且规范化（`path.resolve`），禁止空串。
- **写入范围（用户已确认）**：extra input（`--root` / Input sources 面板添加的目录或单文件）中的会话同样允许迁移。因此不做默认根白名单，安全靠以下约束：① 目标路径规范化后必须位于三个默认根之内（claude 工程迁移的落点固定为 `~/.claude/projects`，不允许把文件挪到任意目录）；② agent 类型由现有 `detectFormat` 正文探测决定，误判风险用户已知悉；③ Hermes 与非 `.jsonl` 文件一律拒绝。

### 5.4 备份与回滚

- 备份根目录：`~/.agent-trace-viewer/backups/<yyyyMMdd-HHmmss>-<随机>/`，按原文件绝对路径的相对结构存放（去掉前导 `/`），保证同批次多文件不冲突。
- 每批次写 `manifest.json`：
  ```json
  {
    "id": "20261116-143005-a1b2",
    "type": "project | account",
    "createdAt": "ISO 时间",
    "ops": [{
      "agent": "codex", "path": "原绝对路径", "movedTo": "新路径或 null",
      "changes": [{"field": "payload.cwd", "from": "...", "to": "..."}],
      "backup": "备份内相对路径",
      "postHash": "操作完成后文件的 sha256",
      "status": "done | failed", "error": null
    }]
  }
  ```
- **漂移检测（回滚前置校验）**：回滚前逐项计算当前文件（移动场景取 `movedTo` 路径）的 sha256，与 manifest 的 `postHash` 比对。不一致说明该批次之后文件又被迁移/外部改动过——整批回滚中止，报告冲突项，由用户决定先回滚更近的批次。文件丢失同样报冲突不静默跳过。
- 回滚：校验通过后按 manifest 反向执行——移动过的先挪回原路径，内容用备份覆盖；回滚执行前再做一次安全备份（`rollback-<原批次id>/`，同样带 manifest），保证回滚本身也可撤销。原路径已被新文件占用时中止并报告冲突。
- 前端「迁移记录」面板（复用现有输入源面板的抽屉样式）：列批次、类型、数量、时间，每批次可展开明细、可回滚。
- 备份不做自动清理（磁盘占用可预期：仅迁移时产生、单文件量级），README 说明手动清理方式。

### 5.5 HTTP API

| 方法/路径 | 说明 |
|---|---|
| `GET /api/identity` | 返回 claude 公共身份、codex 当前邮箱与全部已知 account_id + 备注 |
| `POST /api/identity/notes` | 保存历史账号备注（写 accounts.json） |
| `POST /api/migrate` | body：`{ "type": "project"\|"account", "value": "...", "targets": ["path", ...] }`；仅接受 `application/json`，复用现有跨站防护与 Host 校验；返回逐项结果 + 批次 id |
| `GET /api/migrations` | 备份目录中的批次列表（含 manifest 摘要） |
| `POST /api/migrations/rollback` | body：`{ "id": "<批次id>" }` |

所有写接口与 `/api/inputs` 同等级防护：回环绑定 + Host 头校验 + JSON content-type 要求。

### 5.6 涉及文件

| 文件 | 改动 |
|---|---|
| `src/types.ts` | SessionRow 加 account 字段；新增迁移相关类型 |
| `src/identity.ts` | 新建：身份读取、JWT 解码、备注存取 |
| `src/migrate.ts` | 新建：备份、JSONL 改写、文件移动、回滚 |
| `src/scan.ts` | meta 解析顺带取 codex account；挂 claude 公共身份；输出工程聚合列表 |
| `src/server.ts` | 新增 4 个 API 路由 |
| `src/pages.ts` | 列表页骨架加复选框、批量条、迁移弹窗、迁移记录面板的容器 |
| `web/list.js` / `web/trace.css` | 选择、筛选、弹窗、面板全部交互与样式（trace.js 详情头部小改） |
| `scripts/make-demo.mjs` | demo 数据补 codex account 字段与模拟 auth 文件 |
| `README.md` / `README.zh-CN.md` | 功能表、API 表、安全章节更新（read-only 表述改为「默认只读；迁移操作有备份可回滚」） |

## 6. 安全与隐私

- 凭据文件只取非敏感声明（subscriptionType、userID、JWT 的 email claim），token 字符串不进任何 API 响应、不进日志。
- 全部写操作仅限：各 agent 会话 `.jsonl` 文件（含 extra input 内的文件）与 `~/.agent-trace-viewer/`；所有路径 `path.resolve` 规范化，迁移落点（新工程目录）必须在 `~/.claude/projects` 之内，禁止 `../` 逃逸到任意目录。
- 保持零运行时依赖：JWT 用 Node 内置 `Buffer.from(..., "base64url")` 解码，不引库。
- 离线原则不变，不新增任何网络请求。

## 7. 已知边界

- **OpenClaw trajectory 兄弟文件不动**：`*.trajectory.jsonl` 被列表去重逻辑过滤、本工具不读取；迁移只改 plain 会话文件，trajectory 快照内可能残留旧 cwd，OpenClaw 自身如何消费该快照不在本工具控制范围内。
- **`~/.codex/archived_sessions` 不纳入**：它不在扫描根内，其中历史账号不会进入 identity map、其会话不出现在列表也无法迁移。若未来支持扫描归档，再统一接入。
- **归属与历史刻意分离**：迁移后文件内逐轮 cwd / 内嵌祖先 meta 保留原值，trace 详情里看到的中途 `cd` 历史仍是旧路径，只有列表归属与首条 meta 反映新值。这是用户确认的预期行为，不是 bug。
- **Claude 账号迁移不可用**：磁盘上没有 per-session 账号字段，UI 对 claude 选中项禁用账号迁移并说明原因。

## 8. 留给实现者的决策

- 复选框/批量条/弹窗的具体视觉细节（沿用现有 CSS 变量与明暗主题）。
- 工程名下拉的排序（按会话数或字母序，实现时定）。
- 备份保留数量的软提示阈值（仅 UI 提示，不自动删）。
- 键盘导航与新复选框的焦点共存细节。
