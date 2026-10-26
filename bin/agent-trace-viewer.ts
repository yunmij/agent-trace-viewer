#!/usr/bin/env node
// agent-trace-viewer — 本地 AI agent 会话 trace 浏览器（零依赖，仅 node 内置模块）
//
//   agent-trace-viewer                       # http://localhost:8787
//   agent-trace-viewer --port 9000 --root /abs/dir --root /abs/a.jsonl
//
// 页面：  /  列表 + 搜索；  /session_trace.html?path=...  单会话全页 trace
// 接口：  /api/sessions · /api/render?path=... · /api/inputs
// 安全：  默认仅监听 127.0.0.1；/api/render 只读输入源根目录下的 .jsonl。
import { parseArgs } from "../src/config.ts";
import { startServer } from "../src/server.ts";

const port = parseArgs(process.argv.slice(2));
startServer(port);
