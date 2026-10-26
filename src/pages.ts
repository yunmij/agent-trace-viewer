// pages.ts — HTML 页面外壳。前端逻辑与样式走 /static/*（web/ 目录，浏览器原生资源）。
import path from "node:path";

// 主题在首帧前写到 <html data-theme>，避免暗色用户看到一闪而过的白底。
const THEME_BOOT = `<script>(function(){var t;try{t=localStorage.getItem('atv-theme');}catch(e){}if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;})();</script>`;

const ICONS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
  <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></symbol>
  <symbol id="i-back" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></symbol>
</svg>`;

const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#4f46e5"/><g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M5 7h8M5 12h14M5 17h6"/><circle cx="17" cy="7" r="1.8"/><circle cx="14.5" cy="17" r="1.8"/></g></svg>')}">`;

const LOGO = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7"/><circle cx="18" cy="6" r="2"/><circle cx="15" cy="18" r="2"/></svg>`;

export const LIST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Trace Viewer</title>
${THEME_BOOT}
${FAVICON}
<link rel="stylesheet" href="/static/trace.css">
</head><body class="app">
${ICONS}
<header class="topbar">
  <div class="brand">${LOGO}<span>Agent Trace Viewer</span></div>
  <label class="search"><svg class="ic"><use href="#i-search"/></svg>
    <input id="q" type="search" placeholder="Search title, session id, project, path…  ( / )" autocomplete="off"></label>
  <div class="spacer"></div>
  <span id="stat" class="muted small"></span>
  <button id="refresh" class="iconbtn" title="Refresh"><svg class="ic"><use href="#i-refresh"/></svg></button>
  <button id="inputsBtn" class="iconbtn" title="Input sources"><svg class="ic"><use href="#i-folder"/></svg></button>
  <button id="theme" class="iconbtn" title="Toggle theme"><svg class="ic"><use href="#i-moon"/></svg></button>
</header>
<div class="filters">
  <div id="agents" class="pills" role="tablist"></div>
  <select id="dir" title="Filter by input source"><option value="">All sources</option></select>
  <label class="toggle"><input type="checkbox" id="auto"> Auto-refresh</label>
  <select id="iv" title="Refresh interval"><option value="3000">3s</option><option value="5000" selected>5s</option><option value="10000">10s</option></select>
</div>
<div id="inpPanel" class="panel" hidden>
  <div class="panel-title">Input sources <span class="muted small">— add a folder or a single <code>.jsonl</code> file (absolute path). Defaults are always kept.</span></div>
  <div class="panel-row">
    <input id="inpPath" placeholder="/abs/path/to/dir   or   /abs/path/to/session.jsonl">
    <button id="inpAdd" class="btn primary">Add</button>
    <span id="inpMsg" class="err small"></span>
  </div>
  <div id="inpList"></div>
</div>
<main class="split">
  <section id="list" class="list" aria-label="Sessions"><div id="rows"></div></section>
  <section id="detail" class="detail">
    <div class="empty"><div class="empty-ic">${LOGO}</div><div>Select a session to view its trace</div><div class="muted small">/ to search · j / k or ↑ / ↓ to move between sessions</div></div>
  </section>
</main>
<script src="/static/trace.js"></script>
<script src="/static/list.js"></script>
</body></html>`;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function tracePage(p: string): string {
  // 路径来自 URL 参数：<title> 要转义，进 <script> 的 JSON 要把 < 转义，防止 </script> 截断注入。
  const json = JSON.stringify(p).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(path.basename(p))} · Agent Trace Viewer</title>
${THEME_BOOT}
${FAVICON}
<link rel="stylesheet" href="/static/trace.css">
</head><body class="page">
${ICONS}
<header class="topbar">
  <a class="iconbtn" href="/" title="Back to sessions"><svg class="ic"><use href="#i-back"/></svg></a>
  <div class="brand">${LOGO}<span>Agent Trace Viewer</span></div>
  <div class="spacer"></div>
  <button id="theme" class="iconbtn" title="Toggle theme"><svg class="ic"><use href="#i-moon"/></svg></button>
</header>
<div class="pagebody"><div id="mount"><span class="muted">Loading…</span></div></div>
<script src="/static/trace.js"></script>
<script>initTheme();loadTrace(${json},"#mount");</script>
</body></html>`;
}
