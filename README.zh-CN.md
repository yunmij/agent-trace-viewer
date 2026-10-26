<div align="center">

# Agent Trace Viewer

**看清你的 AI 编程 agent 每一步做了什么。**
本地 Web 界面，浏览 Claude Code、Codex、OpenClaw、Hermes 落在磁盘上的会话 trace。

[![npm](https://img.shields.io/npm/v/agent-trace-viewer?color=4f46e5)](https://www.npmjs.com/package/agent-trace-viewer)
[![node](https://img.shields.io/node/v/agent-trace-viewer?color=4f46e5)](https://nodejs.org)
[![license](https://img.shields.io/github/license/yunmij/agent-trace-viewer?color=4f46e5)](LICENSE)
![dependencies](https://img.shields.io/badge/runtime%20deps-0-4f46e5)

[English](README.md) · 简体中文

<img src="https://raw.githubusercontent.com/yunmij/agent-trace-viewer/main/docs/screenshot-light.png" alt="Agent Trace Viewer 会话列表与 trace 视图" width="900">

</div>

## 为什么需要它

编程 agent 会把每次会话完整记下来：提示词、思考、工具调用、工具输出、hook 注入、token 用量。可这些都是原始 JSONL，读起来很费劲。**Agent Trace Viewer** 把它们变成可搜索、可折叠的时间线，方便你：

- 一步步排查 agent 为什么跑偏
- 复盘一次长时间自主运行到底改了什么
- 对比不同 agent 怎么处理同一个任务
- 翻出上周那条命令或回答

全部在本地运行：不用注册，不上传，没有遥测。

## 快速开始

```bash
npx agent-trace-viewer
```

打开 **<http://localhost:8787>** 就行，本机所有支持的 agent 会话会自动出现。

想全局安装：

```bash
npm install -g agent-trace-viewer
agent-trace-viewer        # 或者用短命令 atv
```

需要 **Node.js 18+**。Hermes 会话要用内置 SQLite，需要 Node 22.5+。

## 功能

| | |
|---|---|
| 🗂 **所有 agent 一个列表** | Claude Code / Codex / OpenClaw / Hermes 的会话按时间倒序排在一起。每行以首条真实提问作为标题，并显示项目目录、时间和大小 |
| 🔎 **筛选与搜索** | 带数量的 agent 药丸按钮；按输入源筛选；在标题、会话 id、项目、路径里做多关键词搜索；agent 运行时可以开自动刷新 |
| 🧵 **好读的 trace** | user / assistant / tool / system 卡片可以逐个折叠。思考、工具调用及结果（按 id 配对）、报错、token 用量、hook 和上下文注入都有标注，低价值的系统噪声默认隐藏 |
| 🎯 **会话内搜索** | 高亮全部命中，Enter / Shift+Enter 跳转，折叠的卡片会自动展开 |
| ⌨️ **键盘友好** | `/` 聚焦搜索，`j` / `k`（或 ↑ / ↓）切换会话 |
| 🌗 **亮色 / 暗色** | 默认跟随系统，随时可以切换 |
| 📁 **任意 JSONL** | 可以额外指定目录或单个文件，格式（Claude / Codex / OpenClaw）按内容自动识别 |
| 🪶 **轻量** | 零运行时依赖，包体积约 40 KB，只读 |

<img src="https://raw.githubusercontent.com/yunmij/agent-trace-viewer/main/docs/screenshot-dark.png" alt="暗色主题、会话内搜索与失败的工具调用" width="900">

## 支持的 agent

| Agent | 默认位置 | 说明 |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `~/.claude/projects/**/*.jsonl` | thinking、工具调用和结果、hook / attachment 注入、usage |
| [Codex CLI](https://github.com/openai/codex) | `~/.codex/sessions/**/rollout-*.jsonl` | reasoning 摘要（加密推理内容不可见）、function call、token 汇总 |
| [OpenClaw](https://github.com/openclaw/openclaw) | `~/.openclaw/agents/**/*.jsonl` | 普通会话日志和 trajectory 快照 |
| Hermes | `~/.hermes/state.db` | 读 SQLite，包括压缩过的历史和会话级汇总 |

缺了你在用的格式？欢迎带一份脱敏样例[提 issue](https://github.com/yunmij/agent-trace-viewer/issues)。

## 用法

```
agent-trace-viewer [--port <n>] [--host <addr>] [--root <dir|file.jsonl> ...]

  -p, --port <n>       监听端口（默认 8787，环境变量 PORT）
      --host <addr>    监听地址（默认 127.0.0.1，环境变量 HOST）
      --root <path>    额外输入源：目录或单个 .jsonl 文件，可重复
  -v, --version        显示版本
  -h, --help           显示帮助
```

```bash
atv --port 9000
atv --root ~/Downloads/shared-traces --root ./bug-report.jsonl
```

运行时也可以在右上角文件夹图标打开的 **Input sources** 面板里增删输入源。

### 用演示数据体验

```bash
npm install
npm run demo        # 在 .demo-home/ 生成虚构会话，只展示这些数据
```

## 安全与隐私

agent 会话里常有源码、文件路径，偶尔还有密钥，所以默认配置比较严：

- **只在本机**：监听 `127.0.0.1`，并拒绝 `Host` 头不是本机名的请求，防 DNS rebinding
- **只读**：从不修改会话文件，只读取输入源下的 `.jsonl`
- **防跨站**：增删输入源必须是 `POST` + `application/json`，其他网站没法触发
- **离线**：不发任何网络请求，没有统计

`--host 0.0.0.0` 会让**局域网里的设备都能读到你本机的全部会话**，只在可信网络里用。

## 开发

```bash
git clone https://github.com/yunmij/agent-trace-viewer.git
cd agent-trace-viewer
npm install
npm start            # 直接运行 TS 源码（Node ≥ 22.18 原生类型擦除）
npm run typecheck
npm run build        # tsc → dist/（发布产物，Node ≥ 18 可运行）
```

`web/` 下是浏览器原生 JS/CSS，改完刷新就生效，不需要构建。

## 许可证

[MIT](LICENSE)
