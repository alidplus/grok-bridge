const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const installer = require("./sdk-installer");

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
      if (!helper.proc) reportError(e, log); // startup problem (Node / SDK), not a run error
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

  ctx.subscriptions.push(vscode.commands.registerCommand("grokBridge.reinstallSdk", async () => {
    try {
      helper.stop();
      const node = installer.resolveNode(vscode.workspace.getConfiguration("grokBridge").get("nodePath"), (l) => log.appendLine(l));
      await ensureSdkWithProgress(ctx, node.path, log, true);
    } catch (e) { reportError(e, log); }
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
