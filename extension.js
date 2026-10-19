const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const installer = require("./sdk-installer");
const { McpServer } = require("./mcp");

class Helper {
  constructor(ctx, log) { this.ctx = ctx; this.log = log; this.proc = null; this.seq = 0; this.waiters = new Map(); }
  // Resolve Node, make sure the SDK is installed (or an override is set), then spawn the helper.
  async start() {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const cfg = vscode.workspace.getConfiguration("grokBridge");
      const node = installer.resolveNode(cfg.get("nodePath"), (l) => this.log.appendLine(l));
      const env = { ...process.env, NODE_NO_WARNINGS: "1" };
      const override = cfg.get("sdkDir");
      if (override) {
        env.GROK_BRIDGE_SDK_DIR = override;
        this.log.appendLine(`using SDK override from grokBridge.sdkDir: ${override}`);
      } else {
        const sdk = await ensureSdkWithProgress(this.ctx, node.path, this.log, false);
        env.GROK_BRIDGE_SDK_DIR = sdk.dir;
      }
      const helper = path.join(this.ctx.extensionPath, "helper.mjs");
      this.log.appendLine(`starting helper: ${node.path} ${helper}`);
      this.spawn(node.path, helper, env);
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  spawn(node, helper, env) {
    const proc = cp.spawn(node, [helper], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { this.log.appendLine("helper: " + line); continue; }
        if (msg.type === "fatal") { this.fatal = msg.error; this.log.appendLine("helper fatal: " + msg.error); continue; }
        const w = this.waiters.get(msg.id);
        if (!w) continue;
        if (msg.type === "event") w.onEvent && w.onEvent(msg.event);
        else { this.waiters.delete(msg.id); msg.type === "error" ? w.reject(new Error(msg.error)) : w.resolve(msg.data); }
      }
    });
    proc.stderr.on("data", (d) => this.log.appendLine("helper stderr: " + d.toString().trim()));
    const fail = (code) => {
      const why = this.fatal ? `${this.fatal} (${code}). Try "Grok Bridge: Reinstall SDK".` : code;
      this.fatal = null;
      this.log.appendLine("helper exited: " + why);
      for (const w of this.waiters.values()) w.reject(new Error("helper exited: " + why));
      this.waiters.clear();
      if (this.proc === proc) this.proc = null;
    };
    proc.on("exit", (c, s) => fail(`code=${c} signal=${s}`));
    proc.on("error", (e) => fail(e.message));
  }
  call(cmd, args = {}, onEvent) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.start().then(() => {
        this.waiters.set(id, { resolve, reject, onEvent });
        this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
      }, reject);
    });
  }
  stop() { if (this.proc) { this.proc.kill(); this.proc = null; } }
  dispose() { this.stop(); }
}

let installing = null;
async function ensureSdkWithProgress(ctx, nodePath, log, force) {
  if (installing) return installing;
  const storageDir = ctx.globalStorageUri.fsPath;
  const have = installer.installedVersion(installer.sdkHome(storageDir));
  if (!force && have === installer.SDK_VERSION) return { dir: installer.sdkHome(storageDir), version: have, installed: false };
  installing = Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Grok Bridge: installing ${installer.SDK_PACKAGE}@${installer.SDK_VERSION}`, cancellable: false },
    async (progress) => {
      try {
        const r = await installer.ensureSdk({ storageDir, nodePath, force, log: (l) => log.appendLine(l), onProgress: (m) => progress.report({ message: m }) });
        vscode.window.showInformationMessage(`Grok Bridge: ${installer.SDK_PACKAGE}@${r.version} installed.`);
        return r;
      } catch (e) {
        log.appendLine("SDK install failed: " + e.message);
        throw new Error(`Installing ${installer.SDK_PACKAGE}@${installer.SDK_VERSION} failed: ${e.message}`);
      }
    })).finally(() => { installing = null; });
  return installing;
}

function reportError(e, log) {
  const msg = e && e.message ? e.message : String(e);
  const actions = /Node/.test(msg) ? ["Open Settings", "Show Log"] : ["Reinstall SDK", "Show Log"];
  vscode.window.showErrorMessage(`Grok Bridge: ${msg}`, ...actions).then((a) => {
    if (a === "Show Log") log.show();
    else if (a === "Open Settings") vscode.commands.executeCommand("workbench.action.openSettings", "grokBridge.nodePath");
    else if (a === "Reinstall SDK") vscode.commands.executeCommand("grokBridge.reinstallSdk");
  });
}

function cfg() { return vscode.workspace.getConfiguration("grokBridge"); }
function defaultCwd() {
  return cfg().get("cwd") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}
// MCP callers may only use folders inside an open workspace folder or grokBridge.allowedRoots (symlinks resolved).
function allowedRoots() {
  const roots = [...(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath), ...(cfg().get("allowedRoots") || [])];
  return roots.map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
}
function checkCwd(cwd) {
  let p;
  try { p = fs.realpathSync(path.resolve(String(cwd).replace(/^~(?=$|[\\/])/, os.homedir()))); } catch { throw new Error(`folder not found: ${cwd}`); }
  const inside = (r) => { const rel = path.relative(r, p); return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel)); };
  if (!allowedRoots().some(inside)) throw new Error(`folder ${p} is outside the open workspace folders and grokBridge.allowedRoots`);
  return p;
}
const firstLine = (s, n = 80) => { const l = String(s || "").trim().split("\n")[0]; return l.length > n ? l.slice(0, n - 1) + "…" : l; };

// The hub owns every run (started from the panel or over MCP) and mirrors it to all open webviews.
class Hub {
  constructor(ctx, helper, log) {
    this.ctx = ctx; this.helper = helper; this.log = log;
    this.views = new Set();
    this.runs = new Map();     // agentId -> live run record
    this.cwds = new Map();     // agentId -> folder it lives in
    this.tickets = new Map();  // panel ticket -> run record, so Stop works while a new agent is starting
    this.mcpRuns = 0;          // MCP runs in flight (capped by grokBridge.mcpMaxRuns)
    this.mcpStatus = { state: "off" };
  }
  broadcast(m) { for (const w of this.views) w.postMessage(m); }
  titles() { return this.ctx.globalState.get("titles", {}); }
  setTitle(agentId, prompt) {
    const t = this.titles();
    if (t[agentId] || !prompt) return;
    t[agentId] = firstLine(prompt);
    const keys = Object.keys(t); if (keys.length > 500) delete t[keys[0]];
    this.ctx.globalState.update("titles", t);
  }
  cwdOf(agentId, cwd) { return cwd || this.cwds.get(agentId) || defaultCwd(); }
  snapshot(r) { return { agentId: r.agentId, runId: r.runId, prompt: r.prompt, model: r.model, cwd: r.cwd, source: r.source, startedAt: r.startedAt, events: r.events }; }

  async list(cwd) {
    const items = await this.helper.call("list", { cwd });
    const titles = this.titles();
    for (const a of items) { this.cwds.set(a.agentId, cwd); a.title = titles[a.agentId] || null; a.running = a.running || this.runs.has(a.agentId); }
    return items;
  }
  async messages(agentId, cwd) {
    const turns = await this.helper.call("messages", { cwd: this.cwdOf(agentId, cwd), agentId });
    if (turns[0]?.user) this.setTitle(agentId, turns[0].user);
    return turns;
  }

  // Returns { started: Promise<record>, done: Promise<result> }.
  run({ cwd, prompt, agentId, model, source, ticket }) {
    if (!prompt || !String(prompt).trim()) throw new Error("prompt is empty");
    if (agentId && this.runs.has(agentId)) throw new Error(`agent ${agentId} is already running; wait for it or cancel_run`);
    cwd = agentId ? this.cwdOf(agentId, cwd) : (cwd || defaultCwd());
    model = model || cfg().get("defaultModel") || "grok-4.5";
    const rec = { agentId, cwd, prompt, model, source, ticket, startedAt: Date.now(), events: [], text: "" };
    if (ticket) this.tickets.set(ticket, rec);
    let ok, fail;
    const started = new Promise((a, b) => { ok = a; fail = b; });
    started.catch(() => {});
    const onEvent = (ev) => {
      if (ev.kind === "info") {
        Object.assign(rec, { agentId: ev.agentId, runId: ev.runId });
        this.runs.set(ev.agentId, rec); this.cwds.set(ev.agentId, cwd); this.setTitle(ev.agentId, prompt);
        this.log.appendLine(`run ${ev.runId} started on ${ev.agentId} (${source}, ${model})`);
        this.broadcast({ type: "run-start", ticket, run: this.snapshot(rec), title: this.titles()[ev.agentId] });
        if (rec.cancelRequested) this.cancel(ev.agentId).catch((e) => this.log.appendLine("cancel: " + e.message));
        return ok(rec);
      }
      const last = rec.events[rec.events.length - 1];
      if (last && (ev.kind === "text" || ev.kind === "thinking") && last.kind === ev.kind) last.text += ev.text;
      else if (ev.kind === "tool" && ev.callId && rec.events.find((e) => e.callId === ev.callId)) Object.assign(rec.events.find((e) => e.callId === ev.callId), ev);
      else if (rec.events.length < 5000) rec.events.push({ ...ev });
      if (ev.kind === "text") rec.text = last && last.kind === "text" ? rec.text + ev.text : ev.text; // last text segment = final answer
      this.broadcast({ type: "run-event", agentId: rec.agentId, event: ev });
    };
    const done = this.helper.call("send", { cwd, prompt, agentId: agentId || null, model }, onEvent).then(
      (r) => { this.end(rec, r); return { ...r, text: rec.text }; },
      (e) => { this.end(rec, { status: "error", error: { message: e.message } }); fail(e); throw e; });
    done.catch(() => {});
    return { started, done };
  }
  end(rec, result) {
    if (rec.ticket) this.tickets.delete(rec.ticket);
    if (rec.agentId && this.runs.get(rec.agentId) === rec) this.runs.delete(rec.agentId);
    result.durationMs = result.durationMs || Date.now() - rec.startedAt;
    this.log.appendLine(`run ${rec.runId || "?"} on ${rec.agentId || "new agent"} ended: ${result.status}${result.error ? " " + errText(result.error) : ""}`);
    if (!rec.agentId) return; // failed before it started: the caller gets the error directly
    this.broadcast({ type: "run-end", ticket: rec.ticket, agentId: rec.agentId, result });
  }
  cancel(agentId) { return this.helper.call("cancel", { agentId }); }
  cancelTicket(ticket) {
    const rec = this.tickets.get(ticket);
    if (!rec) return;
    if (rec.runId) return this.cancel(rec.agentId);
    rec.cancelRequested = true; // cancelled as soon as the SDK reports the run
  }
}

function errText(e) { return typeof e === "string" ? e : e?.message || (e ? JSON.stringify(e) : ""); }

function transcript(agentId, turns) {
  const out = [`Agent ${agentId}: ${turns.length} turn(s)`];
  turns.forEach((t, i) => {
    out.push("", `--- turn ${i + 1}${t.durationMs ? ` (worked ${Math.round(t.durationMs / 1000)}s)` : ""}`, `USER: ${t.user ?? ""}`);
    for (const it of t.items || []) {
      if (it.kind === "text") out.push(`ASSISTANT: ${it.text}`);
      else if (it.kind === "tool") out.push(`[tool] ${it.name} ${it.status}${it.detail ? " " + it.detail : ""}`);
    }
  });
  return out.join("\n");
}

function mcpHandlers(hub) {
  const runTool = async (a) => {
    const max = Math.max(1, Number(cfg().get("mcpMaxRuns")) || 3);
    if (hub.mcpRuns >= max) throw new Error(`${hub.mcpRuns} MCP runs are already in flight (grokBridge.mcpMaxRuns = ${max}); wait or cancel_run`);
    const { started, done } = hub.run(a);
    hub.mcpRuns++;
    done.catch(() => {}).finally(() => { hub.mcpRuns--; });
    const rec = await started;
    const head = { agent_id: rec.agentId, run_id: rec.runId, model: rec.model, cwd: rec.cwd };
    if (a.wait === false) return { ...head, status: "running", note: "poll get_messages or list_agents for progress" };
    const ms = Math.min(1800, Math.max(1, Number(a.timeout_s) || 600)) * 1000;
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
    const r = await Promise.race([done.catch((e) => ({ status: "error", error: { message: e.message } })), timeout]);
    clearTimeout(timer);
    if (!r) return { ...head, status: "running", note: `still running after ${ms / 1000}s; poll get_messages or cancel_run` };
    return { ...head, status: r.status, duration_s: r.durationMs ? Math.round(r.durationMs / 100) / 10 : undefined, result: r.result || r.text || "", error: errText(r.error) || undefined };
  };
  return {
    list_agents: async ({ cwd }) => {
      const dir = checkCwd(cwd || defaultCwd());
      const items = await hub.list(dir);
      return { cwd: dir, agents: items.map((a) => ({ agent_id: a.agentId, title: a.title || a.summary || a.name, status: a.status, running: a.running, last_modified: a.lastModified ? new Date(a.lastModified).toISOString() : undefined })) };
    },
    create_agent: ({ prompt, model, cwd, wait, timeout_s }) => runTool({ prompt, model, cwd: checkCwd(cwd || defaultCwd()), wait, timeout_s, source: "mcp" }),
    send_prompt: ({ agent_id, prompt, model, cwd, wait, timeout_s }) => {
      if (!agent_id) throw new Error("agent_id is required");
      return runTool({ agentId: agent_id, prompt, model, cwd: checkCwd(hub.cwdOf(agent_id, cwd)), wait, timeout_s, source: "mcp" });
    },
    get_messages: async ({ agent_id, cwd }) => {
      if (!agent_id) throw new Error("agent_id is required");
      const text = transcript(agent_id, await hub.messages(agent_id, checkCwd(hub.cwdOf(agent_id, cwd))));
      const live = hub.runs.get(agent_id);
      return live ? `${text}\n\n(run ${live.runId} is still in progress)` : text;
    },
    cancel_run: ({ agent_id }) => hub.cancel(agent_id),
  };
}

const newToken = () => crypto.randomBytes(24).toString("base64url");
// The token lives in SecretStorage (OS keychain). 0.2.0 kept it in globalState: migrate it once and drop the old key.
async function mcpToken(ctx) {
  let t = await ctx.secrets.get("mcpToken");
  const old = ctx.globalState.get("mcpToken");
  if (old !== undefined) {
    if (!t && old) { t = old; await ctx.secrets.store("mcpToken", t); }
    await ctx.globalState.update("mcpToken", undefined);
  }
  if (!t) { t = newToken(); await ctx.secrets.store("mcpToken", t); }
  return t;
}
async function mcpConfig(ctx) {
  return { mcpServers: { "grok-bridge": { url: `http://127.0.0.1:${cfg().get("mcpPort") || 7457}/mcp`, headers: { Authorization: `Bearer ${await mcpToken(ctx)}` } } } };
}
// Opt-in (grokBridge.mcpWriteConfigFile): write <globalStorage>/mcp.json for local scripts. Dir 700, file 600, atomic rename.
// When the setting is off, a file left by an earlier version is removed.
async function syncMcpFile(ctx) {
  const dir = ctx.globalStorageUri.fsPath, file = path.join(dir, "mcp.json");
  if (!cfg().get("mcpWriteConfigFile")) { try { fs.unlinkSync(file); } catch {} return null; }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `.mcp-${crypto.randomBytes(6).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(await mcpConfig(ctx), null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    return file;
  } catch { return null; }
}

function attach(webview, ctx, hub, log) {
  const media = vscode.Uri.joinPath(ctx.extensionUri, "media");
  webview.options = { enableScripts: true, localResourceRoots: [media] };
  const html = fs.readFileSync(path.join(ctx.extensionPath, "media", "panel.html"), "utf8");
  const nonce = crypto.randomBytes(16).toString("base64");
  const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
  webview.html = html
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{csp\}\}/g, webview.cspSource)
    .replace("{{script}}", uri("panel.js"))
    .replace("{{style}}", uri("panel.css"));
  hub.views.add(webview);
  const post = (m) => webview.postMessage(m);
  const sub = webview.onDidReceiveMessage(async (m) => {
    try {
      if (m.type === "init") {
        post({ type: "init", cwd: defaultCwd(), model: cfg().get("defaultModel") || "grok-4.5", mcp: hub.mcpStatus,
          runs: [...hub.runs.values()].map((r) => hub.snapshot(r)), titles: hub.titles() });
        hub.helper.call("models").then((models) => post({ type: "models", models }), (e) => log.appendLine("models: " + e.message));
      } else if (m.type === "list") {
        post({ type: "list", cwd: m.cwd, items: await hub.list(m.cwd) });
      } else if (m.type === "messages") {
        post({ type: "messages", agentId: m.agentId, turns: await hub.messages(m.agentId, m.cwd), title: hub.titles()[m.agentId] });
      } else if (m.type === "send") {
        const { started } = hub.run({ cwd: m.cwd, prompt: m.prompt, agentId: m.agentId || null, model: m.model, source: "panel", ticket: m.ticket });
        await started; // run-start / run-event / run-end are broadcast by the hub
      } else if (m.type === "cancel") {
        if (m.agentId) await hub.cancel(m.agentId); else if (m.ticket) await hub.cancelTicket(m.ticket);
      } else if (m.type === "copy" && typeof m.text === "string") {
        await vscode.env.clipboard.writeText(m.text);
      } else if (m.type === "open" && /^(https?:|mailto:)/.test(m.url || "")) {
        vscode.env.openExternal(vscode.Uri.parse(m.url));
      } else if (m.type === "command") {
        if (["grokBridge.copyMcpConfig", "grokBridge.reinstallSdk"].includes(m.command)) vscode.commands.executeCommand(m.command);
      }
    } catch (e) {
      log.appendLine(`error (${m.type}): ${e.message}`);
      post({ type: "error", op: m.type, ticket: m.ticket, agentId: m.agentId, error: e.message });
      if (!hub.helper.proc) reportError(e, log); // startup problem (Node / SDK), not a run error
    }
  });
  return { dispose() { hub.views.delete(webview); sub.dispose(); } };
}

function activate(ctx) {
  const log = vscode.window.createOutputChannel("Grok Bridge");
  const helper = new Helper(ctx, log);
  const hub = new Hub(ctx, helper, log);
  ctx.subscriptions.push(log, { dispose: () => helper.dispose() });

  let mcp = null;
  const startMcp = async () => {
    if (mcp) { mcp.close(); mcp = null; }
    const port = cfg().get("mcpPort") || 7457;
    if (!cfg().get("mcpEnabled")) { hub.mcpStatus = { state: "off" }; }
    else {
      const server = new McpServer({ token: await mcpToken(ctx), handlers: mcpHandlers(hub), version: ctx.extension.packageJSON.version, log: (l) => log.appendLine(l) });
      try {
        await server.listen(port);
        mcp = server;
        hub.mcpStatus = { state: "on", url: `http://127.0.0.1:${port}/mcp` };
        const file = await syncMcpFile(ctx);
        log.appendLine(`MCP server listening on http://127.0.0.1:${port}/mcp${file ? ` (config written to ${file})` : ""}`);
      } catch (e) {
        hub.mcpStatus = { state: "error", error: e.code === "EADDRINUSE" ? `port ${port} is in use (another Cursor window may own it)` : e.message };
        log.appendLine("MCP server not started: " + hub.mcpStatus.error);
      }
    }
    hub.broadcast({ type: "mcp", mcp: hub.mcpStatus });
  };
  startMcp();
  ctx.subscriptions.push({ dispose: () => mcp && mcp.close() });
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (["mcpPort", "mcpEnabled", "mcpWriteConfigFile"].some((k) => e.affectsConfiguration("grokBridge." + k))) startMcp();
  }));

  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("grokBridge.view", {
    resolveWebviewView(view) { const a = attach(view.webview, ctx, hub, log); view.onDidDispose(() => a.dispose()); },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  ctx.subscriptions.push(vscode.commands.registerCommand("grokBridge.open", () => {
    const panel = vscode.window.createWebviewPanel("grokBridge.panel", "Grok Bridge", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "icon.png");
    const a = attach(panel.webview, ctx, hub, log);
    panel.onDidDispose(() => a.dispose());
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("grokBridge.copyMcpConfig", async () => {
    await vscode.env.clipboard.writeText(JSON.stringify(await mcpConfig(ctx), null, 2));
    const s = hub.mcpStatus;
    vscode.window.showInformationMessage(s.state === "on" ? `Grok Bridge: MCP config copied (${s.url}). Give it to your Grok Bot.`
      : `Grok Bridge: MCP config copied, but the server is ${s.state}${s.error ? ": " + s.error : ""}.`);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("grokBridge.regenerateMcpToken", async () => {
    await ctx.secrets.store("mcpToken", newToken());
    await startMcp();
    vscode.window.showInformationMessage("Grok Bridge: new MCP token created. Old configs stop working; run \"Copy MCP Config\" again.");
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand("grokBridge.reinstallSdk", async () => {
    try {
      helper.stop();
      const node = installer.resolveNode(cfg().get("nodePath"), (l) => log.appendLine(l));
      await ensureSdkWithProgress(ctx, node.path, log, true);
    } catch (e) { reportError(e, log); }
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
