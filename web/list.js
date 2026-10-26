// list.js — 会话列表页：搜索 / agent 筛选 / 输入源面板 / 键盘导航。依赖 trace.js 的 esc / loadTrace / initTheme。
var ALL = [], VIEW = [], selPath = null, timer = null, DIRS = [], agentFilter = "";
var $ = function (s) { return document.querySelector(s); };

function fmtSize(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : n > 1e3 ? Math.round(n / 1e3) + " KB" : n + " B"; }
function shortP(p) { return p.length > 46 ? "…" + p.slice(-44) : p; }
function baseName(p) { if (!p) return ""; var s = p.replace(/[\\/]+$/, ""); return s.slice(s.lastIndexOf("/") + 1) || s; }
function relTime(ms) {
  if (!ms) return "";
  var d = (Date.now() - ms) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  if (d < 86400 * 7) return Math.floor(d / 86400) + "d ago";
  return new Date(ms).toLocaleDateString();
}

function match(r, q) {
  if (!q) return true;
  var hay = [r.title, r.sessionId, r.agent, r.cwd, r.path].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (t) { return hay.indexOf(t) >= 0; });
}

function render() {
  var q = $("#q").value, di = $("#dir").value, dir = di === "" ? "" : DIRS[Number(di)];
  VIEW = ALL.filter(function (r) {
    return (!agentFilter || r.agent === agentFilter)
      && (!dir || r.path === dir || r.path.indexOf(dir + "/") === 0)
      && match(r, q);
  });
  $("#rows").innerHTML = VIEW.length ? VIEW.map(function (r, i) {
    var meta = [
      '<span class="agent a-' + esc(r.agent) + '">' + esc(r.agent) + '</span>',
      '<span title="' + esc(r.mtimeStr) + '">' + esc(relTime(r.mtime)) + '</span>',
      r.cwd ? '<span class="proj" title="' + esc(r.cwd) + '">' + esc(baseName(r.cwd)) + '</span>' : '',
      '<span>' + r.lines + (r.agent === "hermes" ? " msgs" : " lines") + '</span>',
      r.size ? '<span>' + fmtSize(r.size) + '</span>' : '',
    ].filter(Boolean).join('<span class="dot">·</span>');
    return '<div class="row' + (r.path === selPath ? ' sel' : '') + '" data-i="' + i + '" title="' + esc(r.path) + '">'
      + '<div class="rtitle">' + (r.title ? esc(r.title) : '<span class="muted">' + esc(r.sessionId) + '</span>') + '</div>'
      + '<div class="rmeta">' + meta + '<span class="sid">' + esc(r.sessionId.slice(0, 8)) + '</span></div></div>';
  }).join("") : '<div class="empty small">No sessions match.</div>';
  $("#stat").textContent = VIEW.length + " / " + ALL.length + " sessions";
}

// agent 药丸按实际数据动态生成（含数量），新增 agent 无需改前端。
function renderAgents() {
  var counts = {};
  ALL.forEach(function (r) { counts[r.agent] = (counts[r.agent] || 0) + 1; });
  var agents = Object.keys(counts).sort();
  if (agentFilter && !counts[agentFilter]) agentFilter = "";
  var pill = function (val, label, n) {
    return '<button class="fpill' + (agentFilter === val ? ' on' : '') + '" data-agent="' + esc(val) + '">'
      + (val ? '<i class="sw a-' + esc(val) + '"></i>' : '') + esc(label) + ' <span class="n">' + n + '</span></button>';
  };
  $("#agents").innerHTML = pill("", "All", ALL.length) + agents.map(function (a) { return pill(a, a, counts[a]); }).join("");
}

async function populateDirs() {
  try {
    var d = await (await fetch("/api/inputs")).json();
    DIRS = (d.defaults || []).concat(d.extra || []);
    var sel = $("#dir"), cur = sel.value;
    sel.innerHTML = '<option value="">All sources</option>' + DIRS.map(function (p, i) { return '<option value="' + i + '" title="' + esc(p) + '">' + esc(shortP(p)) + '</option>'; }).join("");
    if (cur !== "" && Number(cur) < DIRS.length) sel.value = cur;
  } catch (e) { /* 列表仍可用 */ }
}

async function load() {
  var btn = $("#refresh"); btn.classList.add("spin");
  try { ALL = await (await fetch("/api/sessions")).json(); }
  finally { btn.classList.remove("spin"); }
  renderAgents(); render();
}

async function openRow(i) {
  var r = VIEW[i]; if (!r) return;
  selPath = r.path;
  document.querySelectorAll("#rows .row.sel").forEach(function (el) { el.classList.remove("sel"); });
  var el = document.querySelector('#rows .row[data-i="' + i + '"]');
  if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
  $("#detail").innerHTML = '<div class="detailbar"><a class="btn ghost" target="_blank" href="/session_trace.html?path=' + encodeURIComponent(r.path) + '"><svg class="ic"><use href="#i-external"/></svg> Open in new tab</a></div><div id="tracemount"></div>';
  await loadTrace(r.path, "#tracemount");
}
function selIndex() { for (var i = 0; i < VIEW.length; i++) if (VIEW[i].path === selPath) return i; return -1; }

$("#rows").addEventListener("click", function (e) { var row = e.target.closest(".row"); if (row) openRow(Number(row.dataset.i)); });
$("#agents").addEventListener("click", function (e) { var b = e.target.closest("[data-agent]"); if (!b) return; agentFilter = b.dataset.agent; renderAgents(); render(); });
$("#q").addEventListener("input", render);
$("#dir").addEventListener("change", render);
$("#refresh").addEventListener("click", load);
function setAuto() { if (timer) { clearInterval(timer); timer = null; } if ($("#auto").checked) timer = setInterval(load, Number($("#iv").value)); }
$("#auto").addEventListener("change", setAuto); $("#iv").addEventListener("change", setAuto);

// 键盘：/ 聚焦搜索，j/k 或 ↑/↓ 移动选中，Esc 退出搜索框
document.addEventListener("keydown", function (e) {
  var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); return; }
  if (e.key === "Escape" && document.activeElement === $("#q")) { $("#q").blur(); return; }
  if (typing && document.activeElement !== $("#q")) return;
  var down = e.key === "ArrowDown" || (!typing && e.key === "j"), up = e.key === "ArrowUp" || (!typing && e.key === "k");
  if (down || up) {
    e.preventDefault();
    var i = selIndex(); i = i < 0 ? 0 : Math.max(0, Math.min(VIEW.length - 1, i + (down ? 1 : -1)));
    openRow(i);
  }
});

// ---- 输入源面板（增删走 POST + JSON：跨站页面无法不经 CORS 预检直接触发）----
async function inputsCall(body) {
  return (await fetch("/api/inputs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
}
async function renderInputs() {
  var d = await (await fetch("/api/inputs")).json();
  var def = (d.defaults || []).map(function (p) { return '<div class="inp-row"><span class="badge def">default</span><code>' + esc(p) + '</code></div>'; }).join("");
  var ext = (d.extra || []).map(function (p) { return '<div class="inp-row"><span class="badge add">extra</span><code>' + esc(p) + '</code><button class="btn ghost xs" data-rm="' + esc(p) + '">Remove</button></div>'; }).join("");
  $("#inpList").innerHTML = def + ext + (d.extra && d.extra.length ? "" : '<div class="muted small">No extra sources yet.</div>');
}
$("#inputsBtn").addEventListener("click", async function () {
  var p = $("#inpPanel"); p.hidden = !p.hidden;
  $("#inputsBtn").classList.toggle("on", !p.hidden);
  if (!p.hidden) { await renderInputs(); $("#inpPath").focus(); }
});
$("#inpAdd").addEventListener("click", async function () {
  var v = $("#inpPath").value.trim(); if (!v) return; $("#inpMsg").textContent = "";
  var r = await inputsCall({ add: v });
  if (!r.ok) { $("#inpMsg").textContent = r.error || "Failed to add"; return; }
  $("#inpPath").value = ""; await renderInputs(); await populateDirs(); await load();
});
$("#inpPath").addEventListener("keydown", function (e) { if (e.key === "Enter") $("#inpAdd").click(); });
$("#inpList").addEventListener("click", async function (e) {
  var b = e.target.closest("[data-rm]"); if (!b) return;
  await inputsCall({ remove: b.dataset.rm }); await renderInputs(); await populateDirs(); await load();
});

initTheme();
populateDirs();
load();
