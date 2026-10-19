const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let selected = null, busy = false, liveText = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function fmt(ts) { return ts ? new Date(ts).toLocaleString() : ""; }
function refresh() { vscode.postMessage({ type: "list", cwd: $("cwd").value }); }
function setBusy(b, s) { busy = b; $("send").disabled = b; $("status").textContent = s || ""; }

function renderList(items) {
  const L = $("list"); L.innerHTML = "";
  if (!items.length) { L.append(el("div", "muted", "No SDK agents in this cwd.")); return; }
  for (const a of items) {
    const d = el("div", "agent" + (a.agentId === selected ? " sel" : ""));
    d.append(el("div", null, `${a.name || "(unnamed)"}  ${a.status ? "· " + a.status : ""}`));
    if (a.summary) d.append(el("div", "muted", a.summary));
    d.append(el("div", "muted", `${a.agentId} · ${fmt(a.lastModified)}`));
    d.onclick = () => { selected = a.agentId; $("mode").value = "continue"; renderList(items); vscode.postMessage({ type: "messages", cwd: $("cwd").value, agentId: a.agentId }); };
    L.append(d);
  }
}

function renderTurns(turns) {
  const C = $("conv"); C.innerHTML = "";
  for (const t of turns) {
    if (t.user != null) C.append(el("div", "user", "› " + t.user));
    for (const it of t.items || []) {
      if (it.kind === "text") C.append(el("div", null, it.text));
      else if (it.kind === "thinking") C.append(el("div", "think", it.text));
      else if (it.kind === "tool") C.append(el("div", "tool", `[tool] ${it.name} ${it.status}${it.detail ? "  " + it.detail : ""}`));
      else C.append(el("div", "muted", it.text || ""));
    }
  }
  C.scrollTop = C.scrollHeight;
}

function send() {
  const prompt = $("prompt").value.trim();
  if (!prompt || busy) return;
  const cont = $("mode").value === "continue";
  if (cont && !selected) { $("status").textContent = "Select an agent to continue."; return; }
  if (!cont) $("conv").innerHTML = "";
  $("conv").append(el("div", "user", "› " + prompt));
  liveText = el("div"); $("conv").append(liveText);
  setBusy(true, "running…");
  vscode.postMessage({ type: "send", cwd: $("cwd").value, prompt, agentId: cont ? selected : null, model: $("model").value.trim() || "grok-4.5" });
  $("prompt").value = "";
}

window.addEventListener("message", ({ data: m }) => {
  if (m.type === "init") { $("cwd").value = m.cwd || ""; $("model").value = m.model || "grok-4.5"; refresh(); }
  else if (m.type === "list") renderList(m.items);
  else if (m.type === "messages") { if (m.agentId === selected) renderTurns(m.turns); }
  else if (m.type === "event") {
    const e = m.event;
    if (e.kind === "info") { selected = e.agentId; $("status").textContent = `running ${e.model} · ${e.agentId}`; }
    else if (e.kind === "text") liveText.textContent += e.text;
    else if (e.kind === "tool") { $("conv").append(el("div", "tool", `[tool] ${e.name} ${e.status}`)); liveText = el("div"); $("conv").append(liveText); }
    $("conv").scrollTop = $("conv").scrollHeight;
  }
  else if (m.type === "done") { const r = m.result || {}; setBusy(false, `${r.status} · ${r.agentId || ""}`); $("mode").value = "continue"; refresh(); }
  else if (m.type === "error") { $("conv").append(el("div", "err", `error (${m.op}): ${m.error}`)); if (m.op === "send") setBusy(false, "error"); }
});

$("refresh").onclick = refresh;
$("send").onclick = send;
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); });
$("cwd").addEventListener("change", () => { selected = null; $("conv").innerHTML = ""; refresh(); });
vscode.postMessage({ type: "init" });
