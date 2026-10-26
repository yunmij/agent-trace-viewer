// server.ts — HTTP 服务：页面、静态资源(/static/*)、/api/sessions · /api/render · /api/inputs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST, DEFAULT_ROOTS, HERMES_DB, extraInputs, addInput, removeInput, readVersion } from "./config.ts";
import { scanSessions } from "./scan.ts";
import { renderTranscript } from "./render.ts";
import { LIST_PAGE, tracePage } from "./pages.ts";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const STATIC_TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

// 静态资源按 mtime 缓存正文 + ETag：内容未变走 304，变了自动重读（保留改前端即刷即生效）。
const staticCache = new Map<string, { mtimeMs: number; body: Buffer; etag: string }>();
function serveStatic(name: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const ext = path.extname(name);
  const type = STATIC_TYPES[ext];
  const file = path.join(WEB_DIR, path.basename(name));
  if (!type || !file.startsWith(WEB_DIR)) { res.writeHead(404); res.end("not found"); return; }
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { res.writeHead(404); res.end("not found"); return; }
  let entry = staticCache.get(file);
  if (!entry || entry.mtimeMs !== st.mtimeMs) {
    let body: Buffer; try { body = fs.readFileSync(file); } catch { res.writeHead(404); res.end("not found"); return; }
    entry = { mtimeMs: st.mtimeMs, body, etag: `W/"${st.size}-${st.mtimeMs}"` };
    staticCache.set(file, entry);
  }
  if (req.headers["if-none-match"] === entry.etag) { res.writeHead(304, { etag: entry.etag }); res.end(); return; }
  res.writeHead(200, { "content-type": type, etag: entry.etag, "cache-control": "no-cache" });
  res.end(entry.body);
}

// 仅绑回环地址时，只接受 Host 为本机名的请求：挡住 DNS rebinding（恶意域名解析到 127.0.0.1 后读本机会话）。
// 用户显式 --host 绑到其它地址即视为主动开放，不再校验。
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function hostAllowed(req: http.IncomingMessage): boolean {
  if (!LOOPBACK.has(HOST)) return true;
  const h = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK.has(h);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { buf += c; if (buf.length > 64 * 1024) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data));
}

export function startServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (!hostAllowed(req)) { res.writeHead(403); res.end("forbidden host"); return; }
    const u = new URL(req.url ?? "/", "http://localhost");
    try {
      if (u.pathname === "/" || u.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(LIST_PAGE);
      } else if (u.pathname === "/session_trace.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(tracePage(u.searchParams.get("path") || ""));
      } else if (u.pathname.startsWith("/static/")) {
        serveStatic(u.pathname.slice("/static/".length), req, res);
      } else if (u.pathname === "/api/sessions") {
        sendJson(res, 200, scanSessions());
      } else if (u.pathname === "/api/render") {
        let result: unknown;
        try { result = renderTranscript(u.searchParams.get("path") || ""); }
        catch (e) { result = { error: "render failed: " + (e instanceof Error ? e.message : String(e)) }; }
        sendJson(res, 200, result);
      } else if (u.pathname === "/api/inputs") {
        // 读用 GET；增删只走 POST + application/json（跨站请求需 CORS 预检，本服务不放行）。
        let result: { ok: boolean; error?: string } = { ok: true };
        if (req.method === "POST") {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) { sendJson(res, 415, { ok: false, error: "expected application/json" }); return; }
          const body = await readJson(req);
          if (typeof body.add === "string" && body.add) result = addInput(body.add);
          if (typeof body.remove === "string" && body.remove) removeInput(body.remove);
        }
        sendJson(res, result.ok ? 200 : 400, { ...result, defaults: DEFAULT_ROOTS, extra: extraInputs });
      } else { res.writeHead(404); res.end("not found"); }
    } catch (e) { if (!res.headersSent) { res.writeHead(500); } res.end("internal error"); }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Try --port <n>.`);
    else console.error(String(e));
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST;
    if (!LOOPBACK.has(HOST))
      console.log(`⚠️  Listening on ${HOST}: every local agent session is readable by other devices on this network. Use only on trusted networks.`);
    console.log(`agent-trace-viewer v${readVersion()}  →  http://${shown}:${port}/   (Ctrl-C to quit)`);
    console.log(`Sources: ${DEFAULT_ROOTS.join("  ")}  ${HERMES_DB}`);
    if (extraInputs.length) console.log(`Extra:   ${extraInputs.join("  ")}`);
  });
  return server;
}
