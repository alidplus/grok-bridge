// Grok Bridge helper: JSON-lines bridge between the extension and @cursor/sdk (runs on Node >= 22.13).
// stdin:  {"id":1,"cmd":"list","cwd":"..."}
//         {"id":2,"cmd":"messages","cwd":"...","agentId":"..."}
//         {"id":3,"cmd":"send","cwd":"...","prompt":"...","agentId":null|"...","model":"grok-4.5"}
// stdout: {"id":N,"type":"event","event":{kind:"text"|"tool"|"info",...}}  (send only)
//         {"id":N,"type":"result","data":...} | {"id":N,"type":"error","error":"..."}
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// GROK_BRIDGE_SDK_DIR is a folder whose node_modules contains @cursor/sdk: the extension's own install
// in globalStorage, or the grokBridge.sdkDir override. Falls back to normal resolution for dev use.
import { readFileSync } from "node:fs";
const SDK_DIR = process.env.GROK_BRIDGE_SDK_DIR || "";
function sdkEntry(dir) {
  const pkgDir = path.join(dir, "node_modules", "@cursor", "sdk");
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const exp = pkg.exports?.["."];
    const rel = (typeof exp === "string" ? exp : exp?.import || exp?.default) || pkg.module || "dist/esm/index.js";
    return { file: path.join(pkgDir, rel), version: pkg.version };
  } catch { return null; }
}
const entry = SDK_DIR ? sdkEntry(SDK_DIR) : null;
if (SDK_DIR && (!entry || !existsSync(entry.file))) {
  process.stdout.write(JSON.stringify({ id: null, type: "fatal", error: `@cursor/sdk not found under ${SDK_DIR}` }) + "\n");
  process.exit(3);
}
const { Agent } = await import(entry ? pathToFileURL(entry.file).href : "@cursor/sdk");
const SDK_INFO = entry ? `${entry.version} @ ${SDK_DIR}` : "node resolution";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function findTurn(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 4) return null;
  if (o.agentConversationTurn) return o.agentConversationTurn;
  for (const v of Object.values(o)) { const t = findTurn(v, depth + 1); if (t) return t; }
  return null;
}
const short = (s, n = 200) => (typeof s === "string" ? (s.length > n ? s.slice(0, n) + "…" : s) : undefined);

function toolInfo(tc) {
  const key = Object.keys(tc || {})[0] || "tool";
  const name = key.replace(/ToolCall$/, "");
  const a = tc?.[key]?.args || {};
  const detail = short(a.command ?? a.path ?? a.filePath ?? a.targetFile ?? a.pattern ?? a.query ?? a.url ?? a.description, 160);
  const r = tc?.[key]?.result;
  const status = r ? (r.success ? "completed" : r.error || r.failure ? "error" : "completed") : "unknown";
  return { name, detail, status };
}

function normalize(messages) {
  const turns = [];
  for (const m of messages || []) {
    try {
      const plain = JSON.parse(JSON.stringify(m.message ?? null));
      const t = findTurn(plain);
      if (!t) { turns.push({ role: m.type, items: [{ kind: "raw", text: short(JSON.stringify(m.message), 500) }] }); continue; }
      const items = [];
      for (const s of t.steps || []) {
        if (s.assistantMessage?.text) items.push({ kind: "text", text: s.assistantMessage.text });
        else if (s.thinkingMessage?.text) items.push({ kind: "thinking", text: short(s.thinkingMessage.text, 400) });
        else if (s.toolCall) items.push({ kind: "tool", ...toolInfo(s.toolCall) });
        else items.push({ kind: "other", text: Object.keys(s)[0] });
      }
      turns.push({ user: t.userMessage?.text ?? "", startedAtMs: Number(t.userMessage?.startedAtMs) || undefined, items });
    } catch (e) {
      turns.push({ items: [{ kind: "raw", text: "parse error: " + e.message }] });
    }
  }
  return turns;
}

async function handle(req) {
  const { id, cmd } = req;
  const cwd = req.cwd || process.cwd();
  if (cmd === "ping") return out({ id, type: "result", data: { node: process.version, sdk: SDK_INFO } });
  if (cmd === "list") {
    const r = await Agent.list({ runtime: "local", cwd });
    const items = (r.items || []).map((a) => ({ agentId: a.agentId, name: a.name, summary: a.summary, lastModified: a.lastModified, createdAt: a.createdAt, status: a.status }));
    items.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    return out({ id, type: "result", data: items });
  }
  if (cmd === "messages") {
    const msgs = await Agent.messages.list(req.agentId, { runtime: "local", cwd });
    return out({ id, type: "result", data: normalize(msgs) });
  }
  if (cmd === "send") {
    const opts = { model: { id: req.model || "grok-4.5" }, local: { cwd } };
    const agent = req.agentId ? await Agent.resume(req.agentId, opts) : await Agent.create(opts);
    try {
      const run = await agent.send(req.prompt);
      out({ id, type: "event", event: { kind: "info", agentId: agent.agentId, runId: run.id, model: opts.model.id } });
      for await (const ev of run.stream()) {
        if (ev.type === "assistant") {
          for (const b of ev.message?.content || []) if (b.type === "text") out({ id, type: "event", event: { kind: "text", text: b.text } });
        } else if (ev.type === "tool_call") {
          out({ id, type: "event", event: { kind: "tool", name: ev.name, status: ev.status } });
        }
      }
      const r = await run.wait();
      return out({ id, type: "result", data: { status: r.status, result: r.result, error: r.error, agentId: agent.agentId, runId: run.id } });
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
  throw new Error(`unknown cmd: ${cmd}`);
}

const rl = createInterface({ input: process.stdin });
const pending = new Set();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return out({ id: null, type: "error", error: "bad json" }); }
  const p = handle(req).catch((e) => out({ id: req.id, type: "error", error: `${e?.name || "Error"}: ${e?.message || e}` }));
  pending.add(p); p.finally(() => pending.delete(p));
});
rl.on("close", async () => { await Promise.allSettled([...pending]); process.exit(0); });
