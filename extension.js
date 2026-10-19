const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const MIN_NODE = [22, 13];
function nodeVersionOk(bin) {
  try {
    const v = cp.execFileSync(bin, ["-v"], { encoding: "utf8", timeout: 5000 }).trim().replace(/^v/, "").split(".").map(Number);
    return v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]) ? "v" + v.join(".") : null;
  } catch { return null; }
}
// Find a Node >= 22.13: explicit setting, then PATH, then common version-manager locations.
function resolveNode(log) {
  const configured = vscode.workspace.getConfiguration("grokBridge").get("nodePath");
  if (configured) return configured;
  const home = os.homedir();
  const cands = ["node", "/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node", path.join(home, ".volta/bin/node")];
  for (const base of [path.join(home, ".nvm/versions/node"), path.join(home, ".local/share/fnm/node-versions")]) {
    try {
      for (const d of fs.readdirSync(base).sort().reverse()) {
        cands.push(path.join(base, d, "bin/node"), path.join(base, d, "installation/bin/node"));
      }
    } catch {}
  }
  for (const c of cands) {
    if (c !== "node" && !fs.existsSync(c)) continue;
    const v = nodeVersionOk(c);
    if (v) { log.appendLine(`using node ${v} at ${c}`); return c; }
  }
  throw new Error("No Node >= 22.13 found. Install it or set grokBridge.nodePath.");
}

class Helper {
  constructor(ctx, log) { this.ctx = ctx; this.log = log; this.proc = null; this.seq = 0; this.waiters = new Map(); }
  start() {
    if (this.proc) return;
    const cfg = vscode.workspace.getConfiguration("grokBridge");
    const node = resolveNode(this.log);
    const helper = path.join(this.ctx.extensionPath, "helper.mjs");
    const env = { ...process.env, NODE_NO_WARNINGS: "1" };
    if (cfg.get("sdkDir")) env.GROK_BRIDGE_SDK_DIR = cfg.get("sdkDir");
    this.log.appendLine(`starting helper: ${node} ${helper}`);
    this.proc = cp.spawn(node, [helper], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { this.log.appendLine("helper: " + line); continue; }
        const w = this.waiters.get(msg.id);
        if (!w) continue;
        if (msg.type === "event") w.onEvent && w.onEvent(msg.event);
        else { this.waiters.delete(msg.id); msg.type === "error" ? w.reject(new Error(msg.error)) : w.resolve(msg.data); }
      }
    });
    this.proc.stderr.on("data", (d) => this.log.appendLine("helper stderr: " + d.toString().trim()));
    const fail = (why) => {
      this.log.appendLine("helper exited: " + why);
      for (const w of this.waiters.values()) w.reject(new Error("helper exited: " + why));
      this.waiters.clear(); this.proc = null;
    };
    this.proc.on("exit", (c, s) => fail(`code=${c} signal=${s}`));
    this.proc.on("error", (e) => fail(e.message));
  }
  call(cmd, args = {}, onEvent) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      try { this.start(); } catch (e) { return reject(e); }
      this.waiters.set(id, { resolve, reject, onEvent });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }
  dispose() { if (this.proc) this.proc.kill(); }
}

function defaultCwd() {
  const cfg = vscode.workspace.getConfiguration("grokBridge");
  return cfg.get("cwd") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}

function attach(webview, ctx, helper, log) {
  const media = vscode.Uri.joinPath(ctx.extensionUri, "media");
  webview.options = { enableScripts: true, localResourceRoots: [media] };
  const html = fs.readFileSync(path.join(ctx.extensionPath, "media", "panel.html"), "utf8");
  const nonce = Math.random().toString(36).slice(2);
  webview.html = html
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{csp\}\}/g, webview.cspSource)
    .replace("{{script}}", webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js")).toString());
  const post = (m) => webview.postMessage(m);
  webview.onDidReceiveMessage(async (m) => {
    try {
      if (m.type === "init") {
        post({ type: "init", cwd: defaultCwd(), model: vscode.workspace.getConfiguration("grokBridge").get("defaultModel") });
      } else if (m.type === "list") {
        post({ type: "list", items: await helper.call("list", { cwd: m.cwd }) });
      } else if (m.type === "messages") {
        post({ type: "messages", agentId: m.agentId, turns: await helper.call("messages", { cwd: m.cwd, agentId: m.agentId }) });
      } else if (m.type === "send") {
        const r = await helper.call("send", { cwd: m.cwd, prompt: m.prompt, agentId: m.agentId || null, model: m.model }, (ev) => post({ type: "event", event: ev }));
        post({ type: "done", result: r });
      }
    } catch (e) {
      log.appendLine(`error (${m.type}): ${e.message}`);
      post({ type: "error", op: m.type, error: e.message });
    }
  });
}

function activate(ctx) {
  const log = vscode.window.createOutputChannel("Grok Bridge");
  const helper = new Helper(ctx, log);
  ctx.subscriptions.push(log, { dispose: () => helper.dispose() });

  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("grokBridge.view", {
    resolveWebviewView(view) { attach(view.webview, ctx, helper, log); },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  ctx.subscriptions.push(vscode.commands.registerCommand("grokBridge.open", () => {
    const panel = vscode.window.createWebviewPanel("grokBridge.panel", "Grok Bridge", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    attach(panel.webview, ctx, helper, log);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
