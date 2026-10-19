// Grok Bridge: locate Node >= 22.13 and install a pinned @cursor/sdk into the extension's
// global storage. No dependency on the vscode API, so it can be tested from plain Node.
"use strict";
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SDK_PACKAGE = "@cursor/sdk";
const SDK_VERSION = "1.0.38"; // pinned; bump together with the extension version
const MIN_NODE = [22, 13];
const isWin = process.platform === "win32";

/** Returns { path, version } if `bin` is a Node >= 22.13, else null. Resolves "node" to its real path. */
function probeNode(bin) {
  try {
    const out = cp.execFileSync(bin, ["-p", "process.version + ' ' + process.execPath"], { encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
    const sp = out.indexOf(" ");
    const version = out.slice(0, sp), real = out.slice(sp + 1);
    const [maj, min] = version.replace(/^v/, "").split(".").map(Number);
    if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])) return { path: real, version };
  } catch {}
  return null;
}

/** Find a Node >= 22.13: explicit path, then PATH, then common install / version-manager locations. */
function resolveNode(configured, log = () => {}) {
  if (configured) {
    const n = probeNode(configured);
    if (!n) throw new Error(`grokBridge.nodePath (${configured}) is not a Node.js >= ${MIN_NODE.join(".")} binary.`);
    return n;
  }
  const home = os.homedir();
  const exe = isWin ? "node.exe" : "node";
  const cands = ["node"];
  if (isWin) {
    cands.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", exe));
    if (process.env.NVM_HOME) addVersions(process.env.NVM_HOME, (d) => [path.join(d, exe)]);
  } else {
    cands.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", path.join(home, ".volta/bin/node"));
  }
  addVersions(path.join(home, ".nvm/versions/node"), (d) => [path.join(d, "bin", exe)]);
  addVersions(path.join(home, ".local/share/fnm/node-versions"), (d) => [path.join(d, "installation/bin", exe)]);
  addVersions(path.join(home, "Library/Application Support/fnm/node-versions"), (d) => [path.join(d, "installation/bin", exe)]);
  function addVersions(base, f) {
    try {
      const dirs = fs.readdirSync(base).filter((d) => /^v?\d/.test(d));
      dirs.sort((a, b) => cmpVer(b, a));
      for (const d of dirs) cands.push(...f(path.join(base, d)));
    } catch {}
  }
  for (const c of cands) {
    if (c !== "node" && !fs.existsSync(c)) continue;
    const n = probeNode(c);
    if (n) { log(`using node ${n.version} at ${n.path}`); return n; }
  }
  throw new Error(`No Node.js >= ${MIN_NODE.join(".")} found (checked PATH, nvm, fnm, volta, Homebrew, system). Install Node 22.13+ or set grokBridge.nodePath.`);
}
function cmpVer(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number), pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Command to run npm with the same Node install: prefer node + npm-cli.js, fall back to the npm shim. */
function npmCommand(nodePath) {
  const dir = path.dirname(nodePath);
  for (const cli of [path.join(dir, "../lib/node_modules/npm/bin/npm-cli.js"), path.join(dir, "node_modules/npm/bin/npm-cli.js")]) {
    if (fs.existsSync(cli)) return { cmd: nodePath, args: [path.resolve(cli)], shell: false };
  }
  const shim = path.join(dir, isWin ? "npm.cmd" : "npm");
  if (fs.existsSync(shim)) return { cmd: shim, args: [], shell: isWin };
  throw new Error(`npm not found next to ${nodePath}.`);
}

const sdkHome = (storageDir) => path.join(storageDir, "sdk");

function installedVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "node_modules", SDK_PACKAGE, "package.json"), "utf8")).version; }
  catch { return null; }
}

/**
 * Make sure SDK_VERSION is installed under <storageDir>/sdk. Installs into a temp folder and swaps it in,
 * so a failed install never leaves a half-written SDK. Returns { dir, version, installed }.
 */
async function ensureSdk({ storageDir, nodePath, force = false, log = () => {}, onProgress = () => {} }) {
  const home = sdkHome(storageDir);
  const have = installedVersion(home);
  if (!force && have === SDK_VERSION) return { dir: home, version: have, installed: false };
  log(have ? `SDK ${have} found, installing ${SDK_VERSION}` : `SDK missing, installing ${SDK_PACKAGE}@${SDK_VERSION}`);

  fs.mkdirSync(storageDir, { recursive: true });
  const tmp = path.join(storageDir, `sdk.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "grok-bridge-sdk", private: true, type: "module", dependencies: { [SDK_PACKAGE]: SDK_VERSION } }, null, 2));
  const npm = npmCommand(nodePath);
  const args = [...npm.args, "install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"];
  log(`running: ${npm.cmd} ${args.join(" ")} (cwd ${tmp})`);
  onProgress(`Installing ${SDK_PACKAGE}@${SDK_VERSION}…`);
  const env = { ...process.env, PATH: path.dirname(nodePath) + path.delimiter + (process.env.PATH || ""), npm_config_update_notifier: "false" };
  try {
    await new Promise((resolve, reject) => {
      const p = cp.spawn(npm.cmd, args, { cwd: tmp, env, shell: npm.shell, windowsHide: true });
      let errOut = "";
      p.stdout.on("data", (d) => log(String(d).trimEnd()));
      p.stderr.on("data", (d) => { errOut += d; log(String(d).trimEnd()); });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}${errOut ? ": " + errOut.trim().split("\n").filter((l) => l.trim() && !/^npm error\s*$/.test(l)).slice(0, 3).join(" | ") : ""}`))));
    });
    const got = installedVersion(tmp);
    if (got !== SDK_VERSION) throw new Error(`npm finished but ${SDK_PACKAGE}@${SDK_VERSION} is not in ${tmp} (found ${got})`);
    fs.rmSync(home, { recursive: true, force: true });
    fs.renameSync(tmp, home);
    log(`installed ${SDK_PACKAGE}@${got} into ${home}`);
    return { dir: home, version: got, installed: true };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

module.exports = { SDK_PACKAGE, SDK_VERSION, MIN_NODE, resolveNode, probeNode, npmCommand, ensureSdk, sdkHome, installedVersion };
