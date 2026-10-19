// Runs extension.js outside Cursor with a minimal fake `vscode` module, so the MCP server, the hub and the
// real helper/SDK can be tested with curl. A fake webview logs what the panel would receive.
//   node test/host.js [--cwd DIR] [--port 7457] [--max-runs 3]      then: cat .test-storage/mcp.json
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.dirname(__dirname);
const cursorStorage = path.join(os.homedir(), ".config/Cursor/User/globalStorage/alidplus.grok-bridge");
const storage = path.join(root, ".test-storage");
const settings = { cwd: opt("--cwd", ""), mcpPort: Number(opt("--port", 7457)), mcpEnabled: true, mcpWriteConfigFile: true, mcpMaxRuns: Number(opt("--max-runs", 3)), allowedRoots: [], defaultModel: "grok-4.5", nodePath: "",
  sdkDir: fs.existsSync(path.join(cursorStorage, "sdk")) ? path.join(cursorStorage, "sdk") : "" };
const state = new Map([["mcpToken", "legacy-token-from-0.2.0"]]); // exercises the globalState -> secrets migration
const secrets = new Map();
const Uri = { file: (p) => ({ fsPath: p, toString: () => "file://" + p }), joinPath: (u, ...p) => Uri.file(path.join(u.fsPath, ...p)), parse: (s) => ({ toString: () => s }) };
const noop = () => ({ dispose() {} });
const vscode = {
  Uri, ViewColumn: { Active: -1 }, ProgressLocation: { Notification: 15 },
  workspace: { getConfiguration: () => ({ get: (k) => settings[k] }), workspaceFolders: [{ uri: Uri.file(settings.cwd || process.cwd()) }], onDidChangeConfiguration: noop },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => console.log("[log]", l), show() {}, dispose() {} }),
    registerWebviewViewProvider: (id, p) => { const views = []; setTimeout(() => p.resolveWebviewView(fakeView())); return { dispose() {} }; },
    showInformationMessage: async (m) => console.log("[info]", m), showErrorMessage: async (m) => console.log("[error]", m),
    withProgress: (o, fn) => fn({ report() {} }),
  },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: (id, ...a) => commands[id] && commands[id](...a) },
  env: { clipboard: { writeText: async (t) => { clipboard = t; } }, openExternal() {} },
};
const commands = {}; let clipboard = "";
function fakeView() {
  let handler;
  const counts = {};
  const webview = {
    options: {}, cspSource: "vscode-resource:", html: "",
    asWebviewUri: (u) => u,
    onDidReceiveMessage: (h) => { handler = h; return { dispose() {} }; },
    postMessage: (m) => {
      counts[m.type] = (counts[m.type] || 0) + 1;
      if (m.type === "run-start") console.log(`[panel] run-start ${m.run.agentId} source=${m.run.source} prompt=${JSON.stringify(m.run.prompt)}`);
      else if (m.type === "run-event") { if (m.event.kind !== "text" && m.event.kind !== "thinking") console.log(`[panel] run-event ${m.event.kind} ${m.event.name || ""} ${m.event.status || ""}`); }
      else if (m.type === "run-end") console.log(`[panel] run-end ${m.agentId} ${m.result.status} events=${JSON.stringify(counts)}`);
      else if (m.type === "init") console.log(`[panel] init cwd=${m.cwd} mcp=${JSON.stringify(m.mcp)}`);
      return Promise.resolve(true);
    },
  };
  setTimeout(() => handler && handler({ type: "init" }), 200);
  return { webview, onDidDispose: noop };
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === "vscode" ? "vscode" : realResolve.call(this, req, ...a); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };
const ext = require(path.join(root, "extension.js"));
ext.activate({
  extensionPath: root, extensionUri: Uri.file(root), globalStorageUri: Uri.file(storage), subscriptions: [],
  extension: { packageJSON: require(path.join(root, "package.json")) },
  secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
  globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); } },
});
setTimeout(async () => {
  console.log(`[migration] secrets has token: ${secrets.get("mcpToken") === "legacy-token-from-0.2.0"}, globalState key left: ${state.get("mcpToken") !== undefined}`);
  await commands["grokBridge.copyMcpConfig"](); console.log("[clipboard]", clipboard.replace(/Bearer [^"]+/, "Bearer <token>")); }, 500);
