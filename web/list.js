// list.js — 会话列表页：搜索 / agent·工程·账户筛选 / 输入源面板 / 批量选择迁移 / 记录面板 / 键盘导航。
// 依赖 trace.js 的 esc / loadTrace / initTheme。
var ALL = [], VIEW = [], selPath = null, timer = null, DIRS = [], agentFilter = "";
var picked = new Set();           // 选中会话的 path 集合（复选框）
var identity = null;              // /api/identity 缓存：{ claude, codex, notes }
var migMode = "project";          // 当前迁移弹窗模式
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
function fmtIso(iso) { var t = Date.parse(iso); return isNaN(t) ? iso : new Date(t).toLocaleString(); }

function toast(msg, isErr) {
  var t = $("#toast");
  t.textContent = msg;
  t.className = isErr ? "err" : "";
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () { t.hidden = true; }, 4200);
}

function match(r, q) {
  if (!q) return true;
  var hay = [r.title, r.sessionId, r.agent, r.cwd, r.path, r.accountLabel].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (t) { return hay.indexOf(t) >= 0; });
}

function render() {
  var q = $("#q").value, di = $("#dir").value, dir = di === "" ? "" : DIRS[Number(di)];
  var proj = $("#proj").value, acct = $("#acct").value;
  VIEW = ALL.filter(function (r) {
    return (!agentFilter || r.agent === agentFilter)
      && (!dir || r.path === dir || r.path.indexOf(dir + "/") === 0)
      && (!proj || r.cwd === proj)
      && (!acct || r.accountId === acct)
      && match(r, q);
  });
  $("#rows").innerHTML = VIEW.length ? VIEW.map(function (r, i) {
    var meta = [
      '<span class="agent a-' + esc(r.agent) + '">' + esc(r.agent) + '</span>',
      r.accountLabel ? '<span class="acct" title="' + esc(r.accountId || r.accountLabel) + '">' + esc(r.accountLabel) + '</span>' : '',
      '<span title="' + esc(r.mtimeStr) + '">' + esc(relTime(r.mtime)) + '</span>',
      r.cwd ? '<span class="proj" title="' + esc(r.cwd) + '">' + esc(baseName(r.cwd)) + '</span>' : '',
      '<span>' + r.lines + (r.agent === "hermes" ? " msgs" : " lines") + '</span>',
      r.size ? '<span>' + fmtSize(r.size) + '</span>' : '',
    ].filter(Boolean).join('<span class="dot">·</span>');
    return '<div class="row' + (r.path === selPath ? ' sel' : '') + '" data-i="' + i + '" title="' + esc(r.path) + '">'
      + '<input type="checkbox" class="pick" data-path="' + esc(r.path) + '" title="选择会话（不打开）"' + (picked.has(r.path) ? ' checked' : '') + '>'
      + '<div class="rbody"><div class="rtitle">' + (r.title ? esc(r.title) : '<span class="muted">' + esc(r.sessionId) + '</span>') + '</div>'
      + '<div class="rmeta">' + meta + '<span class="sid">' + esc(r.sessionId.slice(0, 8)) + '</span></div></div></div>';
  }).join("") : '<div class="empty small">No sessions match.</div>';
  $("#stat").textContent = VIEW.length + " / " + ALL.length + " sessions";
  updateBatchBar();
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

// 工程筛选：ALL 的 cwd 去重（值为完整路径）；账户筛选：accountId 去重，显示 label。
function populateFilters() {
  var projSel = $("#proj"), curProj = projSel.value;
  var projs = [];
  ALL.forEach(function (r) { if (r.cwd && projs.indexOf(r.cwd) < 0) projs.push(r.cwd); });
  projs.sort();
  projSel.innerHTML = '<option value="">All projects</option>' + projs.map(function (p) {
    return '<option value="' + esc(p) + '" title="' + esc(p) + '">' + esc(baseName(p)) + '</option>';
  }).join("");
  projSel.value = projs.indexOf(curProj) >= 0 ? curProj : "";

  var acctSel = $("#acct"), curAcct = acctSel.value;
  var acctMap = {};
  ALL.forEach(function (r) { if (r.accountId && !acctMap[r.accountId]) acctMap[r.accountId] = r.accountLabel || r.accountId; });
  var ids = Object.keys(acctMap).sort();
  acctSel.innerHTML = '<option value="">All accounts</option>' + ids.map(function (id) {
    return '<option value="' + esc(id) + '" title="' + esc(id) + '">' + esc(acctMap[id]) + '</option>';
  }).join("");
  acctSel.value = ids.indexOf(curAcct) >= 0 ? curAcct : "";
  toggleNoteBtn();
}

async function populateDirs() {
  try {
    var d = await (await fetch("/api/inputs")).json();
    DIRS = (d.defaults || []).concat(d.extra || []);
    var sel = $("#dir"), cur = sel.value;
    sel.innerHTML = '<option value="">All sources</option>' + DIRS.map(function (p, i) {
      return '<option value="' + i + '" title="' + esc(p) + '">' + esc(shortP(p)) + '</option>';
    }).join("");
    if (cur !== "" && Number(cur) < DIRS.length) sel.value = cur;
  } catch (e) { /* 列表仍可用 */ }
}

async function loadIdentity() {
  try { identity = await (await fetch("/api/identity")).json(); } catch (e) { identity = { claude: null, codex: null, notes: { codex: {} } }; }
}

async function load() {
  var btn = $("#refresh"); btn.classList.add("spin");
  try { ALL = await (await fetch("/api/sessions")).json(); }
  finally { btn.classList.remove("spin"); }
  // 已被删除/迁移走的路径自动退出选择集。
  var live = new Set(ALL.map(function (r) { return r.path; }));
  Array.from(picked).forEach(function (p) { if (!live.has(p)) picked.delete(p); });
  renderAgents(); populateFilters(); render();
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

$("#rows").addEventListener("click", function (e) {
  var pick = e.target.closest(".pick");
  if (pick) {
    // 复选框点击绝不冒泡到行打开逻辑，j/k 导航不受影响。
    e.stopPropagation();
    var p = pick.dataset.path;
    if (pick.checked) picked.add(p); else picked.delete(p);
    updateBatchBar();
    return;
  }
  var row = e.target.closest(".row"); if (row) openRow(Number(row.dataset.i));
});
$("#agents").addEventListener("click", function (e) { var b = e.target.closest("[data-agent]"); if (!b) return; agentFilter = b.dataset.agent; renderAgents(); render(); });
$("#q").addEventListener("input", render);
$("#dir").addEventListener("change", render);
$("#proj").addEventListener("change", render);
$("#acct").addEventListener("change", function () { render(); toggleNoteBtn(); });
$("#refresh").addEventListener("click", load);
function setAuto() { if (timer) { clearInterval(timer); timer = null; } if ($("#auto").checked) timer = setInterval(load, Number($("#iv").value)); }
$("#auto").addEventListener("change", setAuto); $("#iv").addEventListener("change", setAuto);

// ---- 批量选择条 ----
function pickedRows() {
  var byPath = new Map(ALL.map(function (r) { return [r.path, r]; }));
  return Array.from(picked).map(function (p) { return byPath.get(p); }).filter(Boolean);
}
function updateBatchBar() {
  var bar = $("#batchBar");
  bar.hidden = picked.size === 0;
  if (!picked.size) return;
  var rows = pickedRows();
  var agents = new Set(rows.map(function (r) { return r.agent; }));
  $("#batchCount").textContent = "已选 " + picked.size + " 个会话";
  var projBtn = $("#migProj"), acctBtn = $("#migAcct");
  var hasHermes = agents.has("hermes");
  var allCodex = rows.length > 0 && rows.every(function (r) { return r.agent === "codex"; });
  projBtn.disabled = hasHermes;
  projBtn.title = hasHermes ? "Hermes 会话存储在 SQLite，不支持文件迁移" : "把选中会话的归属工程（cwd）迁移到目标目录";
  acctBtn.disabled = !allCodex;
  acctBtn.title = allCodex ? "把选中 Codex 会话的归属账号迁移到目标账号"
    : agents.has("hermes") ? "Hermes 会话不支持账号迁移"
    : agents.has("claude") ? "Claude 会话不支持账号迁移（仅 Codex 支持）"
    : "仅 Codex 会话支持账号迁移";
}
$("#clearPick").addEventListener("click", function () {
  picked.clear(); render();
});

// ---- 迁移弹窗 ----
var MANUAL = "__manual__";
function anyModalOpen() {
  return !$("#migrateModal").hidden || !$("#noteModal").hidden;
}
function knownCwds() {
  var out = [];
  ALL.forEach(function (r) { if (r.cwd && out.indexOf(r.cwd) < 0) out.push(r.cwd); });
  return out.sort();
}
// 账号目标：当前 codex 登录身份 → 备注过的历史账号 → 列表里出现过的其它账号，去重。
function knownAccounts() {
  var map = new Map();
  if (identity && identity.codex) map.set(identity.codex.id, identity.codex.label);
  if (identity && identity.notes && identity.notes.codex) {
    Object.keys(identity.notes.codex).forEach(function (id) { if (!map.has(id)) map.set(id, identity.notes.codex[id]); });
  }
  ALL.forEach(function (r) { if (r.accountId && !map.has(r.accountId)) map.set(r.accountId, r.accountLabel || r.accountId); });
  return Array.from(map).map(function (kv) { return { id: kv[0], label: kv[1] }; });
}
function openMigrate(mode) {
  if (!picked.size) return;
  migMode = mode;
  $("#migMsg").textContent = "";
  $("#migConfirm").checked = false;
  $("#migRun").disabled = true;
  $("#migTitle").textContent = mode === "project" ? "迁移到工程" : "迁移到账号";
  var sel = $("#migTarget"), custom = $("#migCustom"), userId = $("#migUserId");
  if (mode === "project") {
    custom.placeholder = "手动输入：目标工程绝对路径，例如 /Users/me/new-proj";
    userId.hidden = true; userId.value = "";
    sel.innerHTML = knownCwds().map(function (p) {
      return '<option value="' + esc(p) + '" title="' + esc(p) + '">' + esc(p) + '</option>';
    }).join("") + '<option value="' + MANUAL + '">✎ 手动输入绝对路径…</option>';
  } else {
    custom.placeholder = "手动输入：目标 creator_account_id";
    userId.hidden = false; userId.value = "";
    sel.innerHTML = knownAccounts().map(function (a) {
      return '<option value="' + esc(a.id) + '" title="' + esc(a.id) + '">' + esc(a.label) + ' (' + esc(a.id.slice(0, 8)) + '…)</option>';
    }).join("") + '<option value="' + MANUAL + '">✎ 手动输入账号 ID…</option>';
  }
  custom.value = "";
  custom.hidden = sel.value !== MANUAL;
  renderPreview();
  $("#migrateModal").hidden = false;
}
function migTargetValue() {
  var sel = $("#migTarget");
  if (sel.value !== MANUAL) return sel.value;
  return $("#migCustom").value.trim();
}
function renderPreview() {
  var target = migTargetValue(), userId = $("#migUserId").value.trim();
  $("#migPreview").innerHTML = pickedRows().map(function (r) {
    var title = r.title || r.sessionId;
    if (migMode === "project") {
      var field = r.agent === "claude" ? "cwd（同时移动项目目录）" : "cwd";
      return '<tr><td>' + esc(title) + '</td><td><span class="agent a-' + esc(r.agent) + '">' + esc(r.agent) + '</span></td>'
        + '<td>' + esc(field) + '</td><td class="from">' + esc(r.cwd || "(空)") + '</td><td class="to">' + esc(target || "(待填写)") + '</td></tr>';
    }
    return '<tr><td rowspan="2">' + esc(title) + '</td><td rowspan="2"><span class="agent a-' + esc(r.agent) + '">' + esc(r.agent) + '</span></td>'
      + '<td>creator_account_id</td><td class="from">' + esc(r.accountId || "(空)") + '</td><td class="to">' + esc(target || "(待填写)") + '</td></tr>'
      + '<tr><td>creator_user_id</td><td class="from">（会话内现值）</td><td class="to">' + esc(userId || "(待填写)") + '</td></tr>';
  }).join("");
}
$("#migProj").addEventListener("click", function () { openMigrate("project"); });
$("#migAcct").addEventListener("click", function () { openMigrate("account"); });
$("#migTarget").addEventListener("change", function () {
  var manual = $("#migTarget").value === MANUAL;
  $("#migCustom").hidden = !manual;
  renderPreview();
});
$("#migCustom").addEventListener("input", renderPreview);
$("#migUserId").addEventListener("input", renderPreview);
$("#migConfirm").addEventListener("change", function () { $("#migRun").disabled = !this.checked; });
$("#migCancel").addEventListener("click", function () { $("#migrateModal").hidden = true; });
$("#migRun").addEventListener("click", async function () {
  var rows = pickedRows();
  var target = migTargetValue(), msg = $("#migMsg");
  msg.textContent = "";
  if (!target) { msg.textContent = "请选择或填写迁移目标"; return; }
  if (migMode === "project" && target[0] !== "/") { msg.textContent = "工程目标必须是绝对路径"; return; }
  var body = { type: migMode, value: target, targets: rows.map(function (r) { return r.path; }) };
  if (migMode === "account") {
    var userId = $("#migUserId").value.trim();
    if (!userId) { msg.textContent = "账号迁移必须填写 creator_user_id"; return; }
    body.userId = userId;
  }
  $("#migRun").disabled = true;
  var data;
  try {
    var res = await fetch("/api/migrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  } catch (e) {
    msg.textContent = String(e.message || e);
    $("#migRun").disabled = false;
    return;
  }
  var done = data.results.filter(function (x) { return x.status === "done"; }).length;
  var failed = data.results.length - done;
  var firstErr = (data.results.find(function (x) { return x.status === "failed"; }) || {}).error;
  toast("迁移完成：成功 " + done + " 个，失败 " + failed + " 个" + (firstErr ? "（" + firstErr + "）" : ""), failed > 0);
  $("#migrateModal").hidden = true;
  picked.clear();
  await load();
  if (!$("#migPanel").hidden) renderMigrations();
});

// ---- 迁移记录面板 ----
$("#migBtn").addEventListener("click", async function () {
  var p = $("#migPanel"); p.hidden = !p.hidden;
  $("#migBtn").classList.toggle("on", !p.hidden);
  if (!p.hidden) renderMigrations();
});
async function renderMigrations() {
  var list = $("#migList");
  var batches;
  try { batches = await (await fetch("/api/migrations?withOps=1")).json(); }
  catch (e) { list.innerHTML = '<span class="err small">加载迁移记录失败</span>'; return; }
  if (!batches.length) { list.innerHTML = '<span class="muted small">暂无迁移批次。</span>'; return; }
  list.innerHTML = batches.map(function (b) {
    var ops = (b.ops || []).map(function (op) {
      var changes = op.changes.map(function (c) {
        return '<div class="chg"><code>' + esc(c.field) + '</code>：<span class="from">' + esc(c.from || "(空)") + '</span> → <span class="to">' + esc(c.to) + '</span></div>';
      }).join("");
      return '<div class="mig-op ' + esc(op.status) + '">'
        + '<div class="mig-op-head"><span class="op-status ' + esc(op.status) + '">' + esc(op.status) + '</span>'
        + '<span class="agent a-' + esc(op.agent) + '">' + esc(op.agent) + '</span>'
        + '<code class="op-path" title="' + esc(op.path) + '">' + esc(op.path) + '</code></div>'
        + (op.movedTo ? '<div class="small muted">移动到：<code>' + esc(op.movedTo) + '</code></div>' : '')
        + changes + (op.error ? '<div class="err small">⚠ ' + esc(op.error) + '</div>' : '') + '</div>';
    }).join("");
    return '<div class="mig-batch" data-id="' + esc(b.id) + '">'
      + '<div class="mig-head"><button class="caret-btn xs" title="展开/收起明细">▸</button>'
      + '<span class="badge mtype">' + esc(b.type) + '</span>'
      + '<code class="mig-id">' + esc(b.id) + '</code>'
      + '<span class="muted small">' + esc(fmtIso(b.createdAt)) + '</span>'
      + '<span class="muted small">' + b.doneCount + '/' + b.opCount + ' done</span>'
      + '<span class="spacer"></span>'
      + '<button class="btn ghost xs rb">回滚</button></div>'
      + '<div class="mig-ops" hidden>' + (ops || '<span class="muted small">无明细</span>') + '</div></div>';
  }).join("");
}
$("#migList").addEventListener("click", async function (e) {
  var caret = e.target.closest(".caret-btn");
  if (caret) {
    var batch = caret.closest(".mig-batch");
    var opsEl = batch.querySelector(".mig-ops");
    opsEl.hidden = !opsEl.hidden;
    caret.textContent = opsEl.hidden ? "▸" : "▾";
    return;
  }
  var rb = e.target.closest(".rb");
  if (!rb) return;
  var id = rb.closest(".mig-batch").dataset.id;
  if (!window.confirm("确认回滚批次 " + id + "？\n回滚前会做漂移检测与安全备份，文件被外部改动时将整批中止。")) return;
  rb.disabled = true;
  try {
    var res = await fetch("/api/migrations/rollback", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    var failed = data.results.filter(function (x) { return x.status === "failed"; });
    if (failed.length) {
      // 漂移中止等错误必须直达用户：toast + 面板内逐条展示。
      toast("回滚中止或部分失败：" + failed.length + " 项失败", true);
    } else {
      toast("回滚完成：" + data.results.length + " 项已还原");
    }
    await renderMigrations(); await load();
  } catch (err) {
    toast("回滚失败：" + (err.message || err), true);
    rb.disabled = false;
  }
});

// ---- 账号备注 ----
function toggleNoteBtn() {
  var btn = $("#noteBtn"), acct = $("#acct").value;
  btn.hidden = !acct;
  if (acct) {
    var noted = identity && identity.notes && identity.notes.codex && identity.notes.codex[acct];
    btn.title = noted ? "修改该账号备注" : "为该账号添加备注";
  }
}
$("#noteBtn").addEventListener("click", function () {
  var acct = $("#acct").value;
  if (!acct) return;
  $("#noteMsg").textContent = "";
  $("#noteTitle").textContent = "账号备注 · " + acct;
  $("#noteInput").value = (identity && identity.notes && identity.notes.codex && identity.notes.codex[acct]) || "";
  $("#noteModal").hidden = false;
  $("#noteInput").focus();
});
async function saveNote() {
  var acct = $("#acct").value, label = $("#noteInput").value.trim(), msg = $("#noteMsg");
  if (!acct || !label) { msg.textContent = "备注名不能为空"; return; }
  try {
    var res = await fetch("/api/identity/notes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: acct, label: label }),
    });
    var data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
  } catch (e) { msg.textContent = String(e.message || e); return; }
  $("#noteModal").hidden = true;
  toast("备注已保存");
  await loadIdentity(); await load();
}
$("#noteSave").addEventListener("click", saveNote);
$("#noteCancel").addEventListener("click", function () { $("#noteModal").hidden = true; });
$("#noteInput").addEventListener("keydown", function (e) { if (e.key === "Enter") saveNote(); });

// 键盘：/ 聚焦搜索，j/k 或 ↑/↓ 移动选中，Esc 退出搜索框/关闭弹窗
document.addEventListener("keydown", function (e) {
  if (anyModalOpen()) {
    if (e.key === "Escape") { $("#migrateModal").hidden = true; $("#noteModal").hidden = true; }
    return; // 弹窗开启时所有列表快捷键让位，避免误开会话
  }
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
// 点遮罩关闭弹窗
document.querySelectorAll(".modal-mask").forEach(function (mask) {
  mask.addEventListener("click", function (e) { if (e.target === mask) mask.hidden = true; });
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
loadIdentity();
load();
