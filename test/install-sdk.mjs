// Exercises the real install path outside Cursor:
//   node test/install-sdk.mjs [--storage DIR] [--cwd DIR] [--force]
// Default storage is Cursor's globalStorage folder for alidplus.grok-bridge, so a successful run leaves the
// extension ready to use. Then the helper is started against that SDK and asked to ping + list agents.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installer = require(path.join(root, "sdk-installer.js"));
const pkg = require(path.join(root, "package.json"));

function cursorGlobalStorage() {
  const id = `${pkg.publisher}.${pkg.name}`;
  const base = process.platform === "darwin" ? path.join(os.homedir(), "Library/Application Support/Cursor")
    : process.platform === "win32" ? path.join(process.env.APPDATA || "", "Cursor")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor");
  return path.join(base, "User", "globalStorage", id);
}

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const storageDir = path.resolve(opt("--storage") || cursorGlobalStorage());
const cwd = path.resolve(opt("--cwd") || process.cwd());
const force = argv.includes("--force");
const log = (l) => console.log(`[installer] ${l}`);

const node = installer.resolveNode(process.env.GROK_BRIDGE_NODE || "", log);
console.log(`[test] node ${node.version} ${node.path}`);
console.log(`[test] storage ${storageDir}`);
const t0 = Date.now();
const sdk = await installer.ensureSdk({ storageDir, nodePath: node.path, force, log, onProgress: (m) => console.log(`[progress] ${m}`) });
console.log(`[test] sdk ${sdk.version} at ${sdk.dir} (installed=${sdk.installed}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const helper = spawn(node.path, [path.join(root, "helper.mjs")], { env: { ...process.env, NODE_NO_WARNINGS: "1", GROK_BRIDGE_SDK_DIR: sdk.dir }, stdio: ["pipe", "pipe", "inherit"] });
helper.stdout.on("data", (d) => process.stdout.write(`[helper] ${d}`));
helper.stdin.end([{ id: 1, cmd: "ping" }, { id: 2, cmd: "list", cwd }].map((r) => JSON.stringify(r)).join("\n") + "\n");
helper.on("exit", (code) => { console.log(`[test] helper exit ${code}`); process.exit(code ?? 1); });
