function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
// 主题：<html data-theme> + localStorage；按钮图标显示「点了会切到的主题」。
function applyTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem("atv-theme",t);}catch(e){}
  var b=document.getElementById("theme");if(b){b.innerHTML='<svg class="ic"><use href="#i-'+(t==="dark"?"sun":"moon")+'"/></svg>';b.title=t==="dark"?"Switch to light":"Switch to dark";}}
function initTheme(){var b=document.getElementById("theme");if(b)b.addEventListener("click",function(){applyTheme(document.documentElement.dataset.theme==="dark"?"light":"dark");});
  applyTheme(document.documentElement.dataset.theme||"light");}
function clip(s,n){s=String(s==null?"":s);return s.length>n?s.slice(0,n):s;}
function pj(o){try{return JSON.stringify(o,null,2);}catch(e){return String(o);}}
function usageChip(u){if(!u)return"";const i=u.input_tokens||0,o=u.output_tokens||0,c=(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);
  return '<span class="tag">in '+i+' · out '+o+(c?' · cache '+c:'')+'</span>';}
var BT=String.fromCharCode(96);
function mdLight(s){ s=esc(s);
  // 围栏代码块（含可选语言行）→ 暗色代码块；先处理，避免行内反引号跨行误配对
  s=s.replace(new RegExp(BT+BT+BT+'([^\\n]*)\\n([\\s\\S]*?)'+BT+BT+BT,'g'),
    function(_,lang,code){ return '<pre class="cblk">'+code.replace(/\n+$/,'')+'</pre>'; });
  // 清掉残留的成对围栏标记
  s=s.replace(new RegExp(BT+BT+BT,'g'),'');
  // 行内代码：仅限同一行，避免跨行吞并
  s=s.replace(new RegExp(BT+'([^'+BT+'\\n]+)'+BT,'g'),'<code>$1</code>');
  // 加粗：仅限同一行
  s=s.replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>');
  return s;
}
// 时间戳多为 UTC ISO 串：按浏览器本地时区显示；解析失败时退回原样截断。
function fmtTs(ts){ if(!ts) return ""; var d=new Date(ts); if(isNaN(d)) return String(ts).replace("T"," ").slice(0,19);
  var p=function(n){return String(n).padStart(2,"0");};
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds()); }
var ROLE={user:{l:"U",n:"User"},assistant:{l:"A",n:"Assistant"},tool:{l:"T",n:"Tool"},system:{l:"S",n:"System"},developer:{l:"D",n:"Developer"}};
function chip(label){return '<span class="tag">'+esc(label)+'</span>';}
function pillTag(pill, cls, name){return '<span class="tag pilltag"><span class="pill '+cls+'">'+esc(pill)+'</span><span class="pname">'+esc(name)+'</span></span>';}
// 每张卡片本身可折叠：summary=头部(caret+头像+角色+日期+标签+折叠预览)，body=内容
function card(role, ts, tagHTML, preview, bodyHTML, open){
  var m=ROLE[role]||{l:"?",n:role};
  return '<details class="card '+role+'"'+(open?' open':'')+'><summary class="chead">'
    +'<span class="caret">▸</span>'
    +'<span class="avatar '+role+'">'+m.l+'</span>'
    +'<span class="who">'+m.n+'</span>'
    +'<span class="cdate">'+esc(fmtTs(ts))+'</span>'
    +(tagHTML||'')
    +'<span class="cpreview">'+esc(preview||"")+'</span>'
    +'</summary><div class="cbody">'+bodyHTML+'</div></details>';
}
function hookIcon(ev){
  var m={SessionStart:"💉",UserPromptSubmit:"⌨️",PreToolUse:"🪝",PostToolUse:"🪝",PreCompact:"🗜️",Stop:"🛑",SubagentStop:"🛑",Notification:"🔔"};
  return m[ev]||"🪝";
}
function hookDetail(inj){
  // hookName 形如 "PreToolUse:Bash" / "SessionStart:startup"，取冒号后的限定符
  var n=inj.hookName||"", i=n.indexOf(":");
  return i>=0?n.slice(i+1):"";
}
function injBadge(inj){
  if(inj.itype==="hook_additional_context"){
    var ev=inj.hookEvent||inj.hookName||"hook";
    return hookIcon(ev)+" "+ev+" inject";
  }
  if(inj.itype==="hook_success"||inj.itype==="hook_non_blocking_error"){
    var ev2=inj.hookEvent||inj.hookName||"hook", d=hookDetail(inj);
    var warn=inj.itype==="hook_non_blocking_error"?"⚠️ ":"";
    return warn+hookIcon(ev2)+" "+ev2+(d?" · "+d:"");
  }
  if(inj.itype==="hook_blocking_error"){
    var ev3=inj.hookEvent||inj.hookName||"hook";
    return "🛑 "+ev3+" blocked";
  }
  if(inj.itype==="skill_listing") return "🧩 skills";
  if(inj.itype==="task_reminder") return "📌 reminder";
  if(inj.itype.indexOf("mcp")>=0) return "🔌 mcp";
  if(inj.itype.indexOf("deferred")>=0) return "🧰 tools";
  if(inj.itype==="command_permissions") return "🔑 perms";
  if(inj.itype==="system_prompt") return "📜 system-prompt";
  if(inj.itype==="mode") return "🎚️ mode";
  if(inj.itype==="result") return "🔎 result";
  if(inj.itype==="started") return "▶ started";
  if(inj.itype.indexOf("system")===0) return "🛑 stop-hook";
  return "📎 "+inj.itype;
}
function prev(s){return clip(String(s==null?"":s).replace(/\s+/g," ").trim(),110);}
function eventCards(e){
  if(e.role==="system"){
    var inj=e.inj;
    if(inj.trivial) return '<div class="tick">'+esc(injBadge(inj))+(inj.meta?' · '+esc(inj.meta):'')+'</div>';
    var t=inj.text||"(empty)";
    return card("system", e.ts, chip(injBadge(inj)), prev(t), '<div class="ctext">'+esc(t)+'</div>', t.length<=300);
  }
  var out="";
  (e.blocks||[]).forEach(function(b){
    if(b.kind==="text"){
      var tg=e.role==="assistant"?"commentary":(e.role==="user"?"message":"context");
      out+=card(e.role, e.ts, chip(tg), prev(b.text), '<div class="ctext md">'+mdLight(b.text||"")+'</div>', true);
    } else if(b.kind==="thinking"){
      out+=card("assistant", e.ts, chip("thinking"), prev(b.text), '<div class="ctext think">'+esc(b.text||"")+'</div>', false);
    } else if(b.kind==="tool_use"){
      var inp=pj(b.input);
      out+=card("assistant", e.ts, pillTag("tool","tool", b.name), prev(inp), '<pre class="cblk">'+esc(inp)+'</pre>', false);
    } else if(b.kind==="tool_result"){
      var tx=b.text||"";
      out+=card("tool", e.ts, pillTag(b.ok?"result":"error", b.ok?"result":"result err", b.toolName||"tool"), prev(tx), '<pre class="cblk">'+esc(tx)+'</pre>', false);
    } else if(b.kind==="image"){
      out+=card(e.role, e.ts, chip("image"), "🖼️ image", '<div class="muted">🖼️ image</div>', true);
    } else {
      out+=card(e.role, e.ts, chip(b.kind), prev(b.text), '<div class="ctext">'+esc(b.text||"")+'</div>', false);
    }
  });
  return out;
}
// ---- 会话内关键字搜索：高亮 + 定位 ----
function clearMarks(root){ root.querySelectorAll('mark.hl').forEach(function(m){ m.replaceWith(document.createTextNode(m.textContent)); }); root.normalize(); }
function doHighlight(root, q){
  clearMarks(root);
  if(!q) return [];
  var ql=q.toLowerCase(), targets=[];
  var w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode:function(n){ return (n.nodeValue && n.nodeValue.toLowerCase().indexOf(ql)>=0)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT; }});
  var n; while(n=w.nextNode()) targets.push(n);
  var marks=[];
  targets.forEach(function(node){
    var text=node.nodeValue, low=text.toLowerCase(), frag=document.createDocumentFragment(), last=0, pos, i=0;
    while((pos=low.indexOf(ql,i))>=0){
      if(pos>last) frag.appendChild(document.createTextNode(text.slice(last,pos)));
      var m=document.createElement('mark'); m.className='hl'; m.textContent=text.slice(pos,pos+q.length);
      frag.appendChild(m); marks.push(m); last=pos+q.length; i=last;
    }
    if(last<text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  });
  return marks;
}
function openAncestors(el){ var p=el.parentElement; while(p){ if(p.tagName==='DETAILS') p.open=true; p=p.parentElement; } }
function gotoMark(marks, i){ if(!marks.length) return; marks.forEach(function(m){m.classList.remove('cur');}); var m=marks[((i%marks.length)+marks.length)%marks.length]; m.classList.add('cur'); openAncestors(m); m.scrollIntoView({block:'center'}); }
function setupTraceSearch(mount){
  var root=mount.querySelector('.trace'); if(!root) return;
  var q=mount.querySelector('.tq'), cnt=mount.querySelector('.tcount');
  var prev=mount.querySelector('.tprev'), next=mount.querySelector('.tnext');
  if(!q) return;
  var marks=[], idx=0, t;
  function upd(){ cnt.textContent = marks.length ? (idx+1)+'/'+marks.length : (q.value.trim()?'no match':''); }
  function run(){ marks=doHighlight(root, q.value.trim()); idx=0; if(marks.length) gotoMark(marks, 0); upd(); }
  function step(d){ if(!marks.length) return; idx=((idx+d)%marks.length+marks.length)%marks.length; gotoMark(marks, idx); upd(); }
  q.addEventListener('input', function(){ clearTimeout(t); t=setTimeout(run, 200); });
  q.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); marks.length?step(e.shiftKey?-1:1):run(); } });
  next.addEventListener('click', function(){ step(1); });
  prev.addEventListener('click', function(){ step(-1); });
}
async function loadTrace(p, mountSel){
  var mount=document.querySelector(mountSel);
  mount.innerHTML='<span class="muted">Loading…</span>';
  var d;
  try{ d=await (await fetch("/api/render?path="+encodeURIComponent(p))).json(); }
  catch(e){ d={error:String(e)}; }
  if(d.error){mount.innerHTML='<div class="errbox">Failed to load trace: '+esc(d.error)+'</div>';return d;}
  var stats={}, inj=0, tick=0;
  (d.events||[]).forEach(function(e){
    if(e.role==="system"){ if(e.inj&&e.inj.trivial) tick++; else inj++; return; }
    (e.blocks||[]).forEach(function(b){stats[b.kind]=(stats[b.kind]||0)+1;});
  });
  if(inj) stats["inject"]=inj;
  var chips=Object.keys(stats).map(function(k){return '<span class="stat"><b>'+stats[k]+'</b> '+esc(k.replace("_"," "))+'</span>';}).join('');
  mount.innerHTML='<div class="tracehdr"><div class="tt">'+esc(d.title||d.sessionId)+'</div>'+
    '<div class="tmeta"><code>'+esc(d.sessionId)+'</code>'+(d.cwd?'<span class="dot">·</span><span title="working directory">'+esc(d.cwd)+'</span>':'')+'</div>'+
    '<div class="tmeta path" title="'+esc(d.path)+'">'+esc(d.path)+'</div>'+
    '<div class="stats"><span class="stat"><b>'+d.count+'</b> events</span>'+chips+'</div>'+
    '<div class="trow"><div class="tsearch"><svg class="ic"><use href="#i-search"/></svg><input class="tq" placeholder="Find in this session…  (Enter / Shift+Enter)"><span class="tcount"></span><button class="btn ghost xs tprev" title="Previous">▲</button><button class="btn ghost xs tnext" title="Next">▼</button></div>'+
    '<label class="toggle small"><input type="checkbox" class="ht" checked> Hide noise ('+tick+')</label>'+
    '<button class="btn ghost xs" data-all="1">Expand all</button><button class="btn ghost xs" data-all="0">Collapse all</button></div></div>'+
    '<div class="trace hideticks">'+(d.events||[]).map(eventCards).join("")+'</div>';
  var tr=mount.querySelector(".trace");
  mount.querySelector(".ht").addEventListener("change",function(){tr.classList.toggle("hideticks",this.checked);});
  mount.querySelectorAll("[data-all]").forEach(function(b){b.addEventListener("click",function(){tr.querySelectorAll("details.card").forEach(function(x){x.open=b.dataset.all==="1";});});});
  setupTraceSearch(mount);
  return d;
}
