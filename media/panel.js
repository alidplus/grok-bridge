// Grok Bridge webview: a Cursor-style agent chat. Talks to extension.js with postMessage.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const S = {
  cwd: "", model: "grok-4.5", view: "chat",
  agentId: null,          // agent shown in the chat view (null = new chat)
  title: "New Agent",
  titles: {},             // agentId -> first prompt
  runs: new Map(),        // agentId -> live run snapshot (from any source)
  live: null,             // turn object of the run being shown live
  pending: null,          // { ticket, turn } while a new agent is being created from this panel
  list: [], loadingAgent: null,
};

// ---------- small helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function svg(path) { const t = document.createElement("template"); t.innerHTML = `<svg viewBox="0 0 16 16">${path}</svg>`; return t.content.firstChild; }
function dur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function ago(ts) {
  if (!ts) return "";
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const short = (s, n = 70) => { s = String(s || "").trim().split("\n")[0]; return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// ---------- tiny safe markdown ----------
// Everything is HTML-escaped first; only the tags produced here end up in the DOM. Links: http(s)/mailto only.
const safeUrl = (u) => /^(https?:|mailto:)/i.test(u);
function inline(src) {
  const codes = [];
  let s = String(src).replace(/\u0000/g, "").replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, b, c) => { codes.push(c.replace(/^ (.*) $/, "$1")); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, t, u) => (safeUrl(u) ? `<a href="${u}" title="${u}">${t}</a>` : `<span class="link" title="${u}">${t}</span>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"\]])/g, '$1<a href="$2">$2</a>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>").replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>").replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`);
}
const LI = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
function md(src) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const isBlockStart = (l) => FENCE.test(l) || /^#{1,6}\s/.test(l) || LI.test(l) || /^\s*>/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (f) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(f[1])) buf.push(lines[i++]);
      i++;
      out.push(`<pre${f[2] ? ` data-lang="${esc(f[2])}"` : ""}><button class="copy" type="button" title="Copy code" aria-label="Copy code">Copy</button><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${md(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (LI.test(l)) {
      const items = [];
      while (i < lines.length) {
        const m = LI.exec(lines[i]);
        if (m) { items.push({ ind: m[1].replace(/\t/g, "    ").length, ord: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] }); i++; continue; }
        if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !FENCE.test(lines[i])) { items[items.length - 1].text += "\n" + lines[i].trim(); i++; continue; }
        if (!lines[i].trim() && i + 1 < lines.length && LI.test(lines[i + 1])) { i++; continue; }
        break;
      }
      out.push(mdList(items));
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}
function mdList(items) {
  let k = 0;
  const build = (ind) => {
    const first = items[k];
    let s = first.ord ? `<ol${first.start > 1 ? ` start="${first.start}"` : ""}>` : "<ul>";
    while (k < items.length && items[k].ind >= ind) {
      if (items[k].ind === ind && items[k].ord !== first.ord) break; // "- a" then "1. b": two lists
      if (items[k].ind > ind) { s = s.replace(/<\/li>$/, "") + build(items[k].ind) + "</li>"; continue; }
      s += `<li>${items[k].text.split("\n").map(inline).join("<br>")}</li>`; k++;
    }
    return s + (first.ord ? "</ol>" : "</ul>");
  };
  let html = "";
  while (k < items.length) html += build(items[k].ind);
  return html;
}

// ---------- conversation rendering ----------
const conv = $("conv"), chatView = $("chat");
let stick = true;
chatView.addEventListener("scroll", () => { stick = chatView.scrollHeight - chatView.scrollTop - chatView.clientHeight < 40; });
function scrollDown(force) { if (force || stick) requestAnimationFrame(() => { chatView.scrollTop = chatView.scrollHeight; }); }

function makeTurn(userText, opts = {}) {
  const t = { el: el("div", "turn"), group: null, textEl: null, textBuf: "", startedAt: opts.startedAt || Date.now(), timer: null };
  if (opts.source === "mcp") t.el.append(el("div", "source", "Sent by a Grok Bot over MCP"));
  const text = String(userText || "");
  const u = el("div", "user", text); // plain text, white-space: pre-wrap
  t.el.append(u);
  if (text.split("\n").length > 8 || text.length > 700) {
    u.classList.add("clamped");
    const more = el("button", "more", "Show more"); more.type = "button";
    more.onclick = () => { const c = u.classList.toggle("clamped"); more.textContent = c ? "Show more" : "Show less"; };
    t.el.append(more);
  }
  t.meta = el("div", "meta"); t.meta.hidden = true;
  t.el.append(t.meta);
  t.body = el("div", "body");
  t.el.append(t.body);
  conv.append(t.el);
  return t;
}
function setMeta(t, html, cls) { t.meta.hidden = false; t.meta.className = "meta" + (cls ? " " + cls : ""); t.meta.innerHTML = html; }
function startWorking(t, phase) {
  t.phase = phase || "Working";
  const tick = () => setMeta(t, `<span class="spinner"></span><span>${t.phase === "Working" ? `Working · ${dur(Date.now() - t.startedAt)}` : t.phase}</span>`);
  tick(); t.timer = setInterval(tick, 1000);
}
function finishTurn(t, r = {}) {
  clearInterval(t.timer); t.timer = null;
  const ms = r.durationMs || Date.now() - t.startedAt;
  const st = r.status && !/finished|completed/i.test(r.status) ? ` · ${esc(String(r.status).toLowerCase())}` : "";
  const err = r.error && (r.error.message || r.error.code || (typeof r.error === "string" ? r.error : JSON.stringify(r.error)));
  const bad = !!err || /error|fail|cancel/i.test(r.status || "");
  setMeta(t, `Worked for ${dur(ms)}${st}`, bad ? "err" : "");
  announce(/cancel/i.test(r.status || "") ? "Agent stopped" : bad ? "Agent run failed" : "Agent finished replying");
  if (err) showError(t, err);
  t.group && updateGroup(t.group, true);
}
let announceTimer;
function announce(text) { const sr = $("sr"); sr.textContent = ""; clearTimeout(announceTimer); announceTimer = setTimeout(() => { sr.textContent = text; }, 50); }
function showError(t, msg) { const b = el("div", "error-box", msg); (t ? t.body : conv).append(b); scrollDown(); }

let renderQueued = new Set();
function addText(t, text, append, sync) {
  if (!append || !t.textEl) { t.textEl = el("div", "md"); t.textBuf = ""; t.body.append(t.textEl); t.group = null; }
  t.textBuf += text;
  if (sync) { t.textEl.innerHTML = md(t.textBuf); return; }
  renderQueued.add(t); // live deltas: re-render at most once per frame
  requestAnimationFrame(() => { for (const x of renderQueued) if (x.textEl) x.textEl.innerHTML = md(x.textBuf); renderQueued.clear(); scrollDown(); });
}
function addStep(t, step, live) {
  if (!t.group) {
    const d = el("details", "steps");
    const sum = el("summary");
    sum.append(svg('<path d="m6 4 4 4-4 4"/>')); sum.firstChild.classList.add("chev");
    const label = el("span", "sum");
    sum.append(label);
    const ul = el("ul");
    d.append(sum, ul);
    t.body.append(d);
    t.group = { d, label, ul, steps: [], live };
    t.textEl = null;
  }
  const g = t.group;
  let s = step.callId && g.steps.find((x) => x.callId === step.callId);
  if (!s && step.kind === "thinking" && live) { const last = g.steps[g.steps.length - 1]; if (last && last.kind === "thinking") s = last; if (s) { s.text += step.text; step = s; } }
  if (s && s !== step) Object.assign(s, step);
  if (!s) { s = { ...step }; g.steps.push(s); s.li = el("li"); g.ul.append(s.li); }
  if (s.kind === "thinking") {
    s.li.className = "think";
    s.li.innerHTML = `<span class="n">Thought</span><span class="d">${esc(short(s.text, 300))}</span>`;
  } else {
    const ok = /complete|success/i.test(s.status || ""), bad = /error|fail/i.test(s.status || "");
    s.li.className = bad ? "error" : "";
    s.li.innerHTML = `<span class="n">${esc(s.name || "tool")}</span><span class="d">${esc(s.detail || "")}</span><span class="st">${bad ? "failed" : ok ? "✓" : live ? "…" : ""}</span>`;
  }
  updateGroup(g, !live);
  scrollDown();
}
function updateGroup(g, done) {
  const tools = g.steps.filter((s) => s.kind !== "thinking");
  const thought = g.steps.length > tools.length;
  const running = !done && tools.find((s) => !/complete|success|error|fail/i.test(s.status || ""));
  let text;
  if (running) text = `Running ${running.name}${running.detail ? " · " + running.detail : ""}`;
  else if (!tools.length) text = done ? "Thought" : "Thinking…";
  else text = `${thought ? "Thought, " : ""}${tools.length === 1 ? `ran ${tools[0].name}${tools[0].detail ? " · " + tools[0].detail : ""}` : `ran ${tools.length} tools`}`;
  g.label.textContent = text.charAt(0).toUpperCase() + text.slice(1);
}

function renderHistory(turns) {
  conv.innerHTML = "";
  for (const tr of turns) {
    const t = makeTurn(tr.user, { startedAt: tr.startedAtMs });
    if (tr.durationMs) setMeta(t, `Worked for ${dur(tr.durationMs)}`);
    for (const it of tr.items || []) {
      if (it.kind === "text") addText(t, it.text, false, true);
      else if (it.kind === "tool") addStep(t, { kind: "tool", ...it }, false);
      else if (it.kind === "thinking") addStep(t, { kind: "thinking", text: it.text }, false);
    }
  }
}
function applyEvent(t, ev, sync) {
  if (ev.kind === "text") addText(t, ev.text, true, sync);
  else if (ev.kind === "thinking") addStep(t, { kind: "thinking", text: ev.text }, true);
  else if (ev.kind === "tool") addStep(t, { kind: "tool", callId: ev.callId, name: ev.name, status: ev.status, detail: ev.detail }, true);
}
function showLive(run) {
  const t = makeTurn(run.prompt, { startedAt: run.startedAt, source: run.source });
  startWorking(t);
  for (const ev of run.events || []) applyEvent(t, ev, true);
  S.live = t;
  scrollDown(true);
  return t;
}

// ---------- views ----------
function setTitle(text) { S.title = text || "New Agent"; $("title").textContent = S.view === "history" ? "History" : S.title; $("title").title = S.title; }
function updateEmpty() { $("empty").hidden = S.agentId != null || !!S.pending || conv.childElementCount > 0; $("emptyCwd").textContent = base(S.cwd) || "this folder"; $("emptyCwd").title = S.cwd; }
const isRunning = () => (S.agentId ? S.runs.has(S.agentId) : !!S.pending);
function updateComposer() {
  const running = isRunning();
  const btn = $("send");
  btn.classList.toggle("stop", running);
  btn.title = running ? "Stop" : "Send (Enter)";
  btn.setAttribute("aria-label", running ? "Stop" : "Send");
  btn.disabled = running ? false : !$("prompt").value.trim();
  $("liveDot").hidden = !running || S.view !== "chat";
  $("hint").textContent = running ? "" : S.agentId ? "" : `New agent in ${base(S.cwd)}`;
}
function show(view) {
  S.view = view;
  $("chat").hidden = view !== "chat";
  $("historyView").hidden = view !== "history";
  $("back").hidden = view !== "history";
  $("history").classList.toggle("on", view === "history");
  setTitle(S.title);
  if (view === "history") { refresh(); $("cwd").value = S.cwd; }
  updateComposer();
}
function newChat() {
  S.agentId = null; S.live = null; S.pending = null; conv.innerHTML = "";
  setTitle("New Agent"); show("chat"); updateEmpty(); $("prompt").focus();
}
function openAgent(id) {
  S.agentId = id; S.live = null; S.pending = null; S.loadingAgent = id;
  conv.innerHTML = ""; conv.append(el("div", "meta", "Loading conversation…"));
  const a = S.list.find((x) => x.agentId === id);
  setTitle(S.titles[id] || a?.title || a?.summary || a?.name || id);
  show("chat"); updateEmpty(); hideNotice();
  vscode.postMessage({ type: "messages", cwd: S.cwd, agentId: id });
}
function refresh() {
  if (S.view !== "history") return;
  if (!S.list.length) $("list").innerHTML = `<div class="msg">Loading agents…</div>`;
  vscode.postMessage({ type: "list", cwd: S.cwd });
}
function renderList(items) {
  S.list = items;
  const L = $("list"); L.innerHTML = "";
  if (!items.length) { L.innerHTML = `<div class="msg">No agents in this folder yet. Start one from the box below.</div>`; return; }
  for (const a of items) {
    const b = el("button", "item" + (a.agentId === S.agentId ? " sel" : ""));
    b.type = "button";
    const top = el("div", "item-top");
    top.append(el("span", "item-title", S.titles[a.agentId] || a.title || a.summary || a.name || "Untitled agent"), el("span", "item-time", ago(a.lastModified)));
    const sub = el("div", "item-sub");
    const running = a.running || S.runs.has(a.agentId);
    if (running) sub.append(el("span", "run", "● Running"));
    else if (a.status && a.status !== "finished") sub.append(el("span", null, a.status));
    sub.append(el("span", null, a.agentId.replace(/^agent-/, "").slice(0, 8)));
    b.append(top, sub);
    b.title = a.agentId;
    b.onclick = () => openAgent(a.agentId);
    L.append(b);
  }
}
function renderMcp(m) {
  const f = $("mcp"); f.innerHTML = "";
  if (!m || m.state === "off") f.append("MCP server is off (grokBridge.mcpEnabled).");
  else if (m.state === "error") { const s = el("span", "bad", `MCP server not running: ${m.error}`); f.append(s); }
  else f.append(`MCP server on ${m.url.replace(/^http:\/\//, "")} · `);
  if (m && m.state === "on") { const b = el("button", null, "Copy config for Grok Bot"); b.type = "button"; b.onclick = () => vscode.postMessage({ type: "command", command: "grokBridge.copyMcpConfig" }); f.append(b); }
}
function notice(text, agentId) {
  const n = $("notice"); n.innerHTML = "";
  n.append(el("span", null, text));
  const v = el("button", null, "View"); v.type = "button"; v.onclick = () => openAgent(agentId);
  const x = el("button", null, "Dismiss"); x.type = "button"; x.onclick = hideNotice;
  n.append(v, x); n.hidden = false; S.notice = agentId;
}
function hideNotice() { $("notice").hidden = true; S.notice = null; }

// ---------- composer ----------
const prompt = $("prompt");
function autosize() { prompt.style.height = "auto"; prompt.style.height = Math.min(prompt.scrollHeight, 220) + "px"; }
function send() {
  const text = prompt.value.trim();
  if (!text) return;
  if (S.agentId ? S.runs.has(S.agentId) : S.pending) return;
  const ticket = Math.random().toString(36).slice(2);
  const t = makeTurn(text, { startedAt: Date.now() });
  startWorking(t, S.agentId ? "Working" : "Starting…");
  S.live = t;
  if (!S.agentId) { S.pending = { ticket, turn: t }; setTitle(short(text, 60)); }
  else S.runs.set(S.agentId, { agentId: S.agentId, prompt: text, startedAt: Date.now(), events: [], ticket });
  updateEmpty();
  vscode.postMessage({ type: "send", ticket, cwd: S.cwd, prompt: text, agentId: S.agentId, model: $("model").value || S.model });
  prompt.value = ""; autosize(); scrollDown(true); updateComposer();
}
function stop() {
  if (!isRunning()) return;
  if (S.pending) vscode.postMessage({ type: "cancel", ticket: S.pending.ticket }); // new agent still starting
  else vscode.postMessage({ type: "cancel", agentId: S.agentId });
  if (S.live) S.live.phase = "Stopping…";
}
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if ($("send").classList.contains("stop")) return stop();
  send();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.view === "chat" && isRunning()) { e.preventDefault(); stop(); } });
prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
prompt.addEventListener("input", () => { autosize(); updateComposer(); });
$("model").addEventListener("change", () => vscode.setState({ ...(vscode.getState() || {}), model: $("model").value }));
function fillModels(models) {
  const sel = $("model");
  const want = sel.value || (vscode.getState() || {}).model || S.model;
  const list = [...models].filter((m) => m.id !== "default");
  list.sort((a, b) => (/^grok/.test(b.id) - /^grok/.test(a.id)) || 0);
  if (!list.find((m) => m.id === want)) list.unshift({ id: want, name: want });
  sel.innerHTML = "";
  for (const m of list) { const o = el("option", null, m.name || m.id); o.value = m.id; sel.append(o); }
  sel.value = want;
}

// ---------- top bar + misc ----------
$("new").onclick = newChat;
$("history").onclick = () => show(S.view === "history" ? "chat" : "history");
$("back").onclick = () => show("chat");
$("cwd").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = $("cwd").value.trim();
  if (v && v !== S.cwd) { S.cwd = v; S.list = []; if (!S.agentId) updateEmpty(); updateComposer(); }
  refresh();
});
document.addEventListener("click", (e) => {
  const c = e.target.closest && e.target.closest(".copy");
  if (c) {
    vscode.postMessage({ type: "copy", text: c.nextElementSibling ? c.nextElementSibling.textContent : "" });
    c.textContent = "Copied"; setTimeout(() => { c.textContent = "Copy"; }, 1200);
    return;
  }
  const a = e.target.closest && e.target.closest("a[href]");
  if (a) { e.preventDefault(); vscode.postMessage({ type: "open", url: a.getAttribute("href") }); }
});

// ---------- messages from the extension ----------
window.addEventListener("message", ({ data: m }) => {
  if (m.type === "init") {
    S.cwd = m.cwd || ""; S.model = m.model || "grok-4.5"; S.titles = m.titles || {};
    for (const r of m.runs || []) S.runs.set(r.agentId, r);
    fillModels([{ id: S.model, name: S.model }]); renderMcp(m.mcp); newChat();
  } else if (m.type === "models") {
    if (m.models?.length) fillModels(m.models);
  } else if (m.type === "mcp") {
    renderMcp(m.mcp);
  } else if (m.type === "list") {
    if (m.cwd === S.cwd) renderList(m.items);
  } else if (m.type === "messages") {
    if (m.agentId !== S.agentId || S.loadingAgent !== m.agentId) return;
    S.loadingAgent = null;
    if (m.title) { S.titles[m.agentId] = m.title; setTitle(m.title); }
    const run = S.runs.get(m.agentId);
    let turns = m.turns || [];
    if (run && turns.length && turns[turns.length - 1].user === run.prompt) turns = turns.slice(0, -1); // shown live instead
    renderHistory(turns);
    if (run && run.runId) showLive(run);
    else if (!turns.length) conv.append(el("div", "meta", "This agent has no messages yet."));
    scrollDown(true); updateComposer();
  } else if (m.type === "run-start") {
    const r = m.run;
    S.runs.set(r.agentId, r);
    if (m.title) S.titles[r.agentId] = m.title;
    if (S.pending && S.pending.ticket === m.ticket) {
      S.agentId = r.agentId; S.pending = null;
      if (S.live && S.live.phase === "Starting…") S.live.phase = "Working";
      announce("Agent is replying");
    } else if (S.agentId === r.agentId && !S.live) {
      showLive(r); announce("Agent is replying");
    } else if (S.agentId === r.agentId && S.live && r.source !== "panel") {
      S.live = showLive(r); announce("Agent is replying"); // a bot continued the agent we are looking at
    } else if (S.agentId === r.agentId && S.live) {
      announce("Agent is replying");
    } else if (S.agentId == null && !S.pending && conv.childElementCount === 0 && S.view === "chat") {
      S.agentId = r.agentId; setTitle(m.title || short(r.prompt, 60)); updateEmpty(); showLive(r); announce("Agent is replying"); // follow a bot's new agent
    } else if (r.source === "mcp") {
      notice(`A Grok Bot is running “${short(m.title || r.prompt, 50)}”`, r.agentId);
    }
    updateComposer(); refresh();
  } else if (m.type === "run-event") {
    const r = S.runs.get(m.agentId);
    if (r && r.events) mergeEvent(r.events, m.event);
    if (m.agentId === S.agentId && S.live) applyEvent(S.live, m.event);
  } else if (m.type === "run-end") {
    const wasPending = S.pending && S.pending.ticket === m.ticket;
    if (m.agentId) S.runs.delete(m.agentId);
    if ((m.agentId && m.agentId === S.agentId && S.live) || wasPending) { finishTurn(S.live, m.result); S.live = null; }
    if (wasPending) S.pending = null;
    if (S.notice === m.agentId) hideNotice();
    updateComposer(); refresh();
  } else if (m.type === "error") {
    if (m.op === "send") {
      // Only touch the chat this send came from; a stale error must not clear another run.
      const pending = S.pending && S.pending.ticket === m.ticket;
      const cont = S.agentId && S.runs.get(S.agentId)?.ticket === m.ticket;
      if (!pending && !cont) return;
      if (pending) S.pending = null;
      if (cont) S.runs.delete(S.agentId);
      if (S.live) { finishTurn(S.live, { status: "error", error: m.error }); S.live = null; }
      else showError(null, m.error);
      updateComposer();
    } else if (m.op === "list") {
      $("list").innerHTML = ""; $("list").append(el("div", "msg", `Couldn't list agents: ${m.error}`));
    } else if (m.op === "messages") {
      conv.innerHTML = ""; showError(null, `Couldn't load this conversation: ${m.error}`);
    } else showError(S.live, `${m.op}: ${m.error}`);
  }
});
function mergeEvent(events, ev) {
  const last = events[events.length - 1];
  if (last && (ev.kind === "text" || ev.kind === "thinking") && last.kind === ev.kind) last.text += ev.text;
  else if (ev.kind === "tool" && ev.callId && events.find((e) => e.callId === ev.callId)) Object.assign(events.find((e) => e.callId === ev.callId), ev);
  else events.push({ ...ev });
}
vscode.postMessage({ type: "init" });
