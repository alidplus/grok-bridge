// Grok Bridge MCP server: a tiny hand-rolled MCP endpoint (Streamable HTTP, JSON responses only).
// POST http://127.0.0.1:<port>/mcp with "Authorization: Bearer <token>". Methods: initialize, ping, tools/list, tools/call.
// No SSE stream: every request gets a single application/json response, which the spec allows.
const http = require("http");
const crypto = require("crypto");

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1 << 20;

const str = (description) => ({ type: "string", description });
const TOOLS = [
  {
    name: "list_agents",
    description: "List local Cursor SDK agents for a folder, newest first. `running` is true while a run is in flight.",
    inputSchema: { type: "object", properties: { cwd: str("Folder whose agents to list. Default: the Cursor workspace folder.") } },
  },
  {
    name: "create_agent",
    description: "Start a new local Cursor agent with a prompt. With wait=true (default) it returns the agent's final reply; " +
      "long runs return status \"running\" after timeout_s, then poll get_messages. The run shows live in Cursor's Grok Bridge panel.",
    inputSchema: {
      type: "object", required: ["prompt"],
      properties: {
        prompt: str("What the agent should do."),
        model: str("Model id, e.g. grok-4.5. Default: the grokBridge.defaultModel setting."),
        cwd: str("Folder the agent works in. Default: the Cursor workspace folder."),
        wait: { type: "boolean", description: "Wait for the run to finish (default true).", default: true },
        timeout_s: { type: "number", description: "Max seconds to wait when wait=true (default 600)." },
      },
    },
  },
  {
    name: "send_prompt",
    description: "Send a follow-up prompt to an existing agent (continues its conversation). Fails if that agent is already running.",
    inputSchema: {
      type: "object", required: ["agent_id", "prompt"],
      properties: {
        agent_id: str("Agent id from list_agents or create_agent."),
        prompt: str("The message."),
        wait: { type: "boolean", description: "Wait for the run to finish (default true).", default: true },
        timeout_s: { type: "number", description: "Max seconds to wait when wait=true (default 600)." },
        model: str("Optional model id for this run."),
        cwd: str("Agent folder, only needed if the agent was not created or listed in this session."),
      },
    },
  },
  {
    name: "get_messages",
    description: "Read an agent's conversation: user prompts, assistant replies and tool steps.",
    inputSchema: { type: "object", required: ["agent_id"], properties: { agent_id: str("Agent id."), cwd: str("Agent folder (optional).") } },
  },
  {
    name: "cancel_run",
    description: "Cancel the agent's in-flight run.",
    inputSchema: { type: "object", required: ["agent_id"], properties: { agent_id: str("Agent id.") } },
  },
];

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const isLocalOrigin = (o) => { try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(o).hostname); } catch { return false; } };

class McpServer {
  // handlers: { [toolName]: async (args) => any }  (a string result is sent as-is, anything else as JSON)
  constructor({ token, handlers, version, log }) { this.token = token; this.handlers = handlers; this.version = version; this.log = log || (() => {}); this.server = null; }

  listen(port, host = "127.0.0.1") {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res).catch((e) => {
        this.log("mcp: " + e.message);
        if (!res.headersSent) this.send(res, 500, rpcError(null, -32603, e.message));
      }));
      server.requestTimeout = 0; // tool calls with wait=true can take minutes
      server.headersTimeout = 30000;
      server.keepAliveTimeout = 5000;
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); this.server = server; resolve(server.address()); });
    });
  }
  close() { if (this.server) { this.server.closeAllConnections?.(); this.server.close(); this.server = null; } }

  send(res, status, body, headers = {}) {
    const data = body == null ? "" : JSON.stringify(body);
    res.writeHead(status, { ...(body == null ? {} : { "Content-Type": "application/json" }), ...headers });
    res.end(data);
  }
  authorized(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (!m) return false;
    const a = Buffer.from(m[1].trim()), b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async onRequest(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/mcp") return this.send(res, 404, { error: "not found; the MCP endpoint is /mcp" });
    // Browsers always send Origin; refuse non-local pages (DNS rebinding). CLI/bot clients send none.
    if (req.headers.origin && !isLocalOrigin(req.headers.origin)) return this.send(res, 403, { error: "origin not allowed" });
    if (!this.authorized(req)) return this.send(res, 401, { error: "missing or wrong bearer token" }, { "WWW-Authenticate": "Bearer" });
    if (req.method !== "POST") return this.send(res, 405, { error: "only POST is supported (no SSE stream)" }, { Allow: "POST" });

    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return this.send(res, 413, rpcError(null, -32600, "body too large")); chunks.push(c); }
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return this.send(res, 400, rpcError(null, -32700, "parse error")); }

    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map((m) => this.dispatch(m)))).filter(Boolean);
    if (!replies.length) return this.send(res, 202, null); // only notifications / responses
    this.send(res, 200, batch ? replies : replies[0]);
  }

  async dispatch(m) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      return m && "id" in m && !("result" in m || "error" in m) ? rpcError(m.id, -32600, "invalid request") : null;
    }
    const isNotification = !("id" in m);
    const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": {
        const want = m.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "grok-bridge", title: "Grok Bridge", version: this.version },
          instructions: "Drive local Cursor agents on this machine. create_agent starts one, send_prompt continues it, " +
            "get_messages reads the transcript, list_agents shows agents per folder, cancel_run stops a run. " +
            "Agents can edit files and run commands in their folder without approval prompts.",
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const name = m.params?.name, args = m.params?.arguments || {};
        const fn = this.handlers[name];
        if (!fn) return isNotification ? null : rpcError(m.id, -32602, `unknown tool: ${name}`);
        this.log(`mcp: tools/call ${name}`);
        try {
          const r = await fn(args);
          return reply({ content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 2) }], isError: false });
        } catch (e) {
          const msg = String(e?.message || e);
          return reply({ content: [{ type: "text", text: /^\w*Error\b/.test(msg) ? msg : `Error: ${msg}` }], isError: true });
        }
      }
      default:
        if (m.method.startsWith("notifications/")) return null;
        return isNotification ? null : rpcError(m.id, -32601, `method not found: ${m.method}`);
    }
  }
}

module.exports = { McpServer, TOOLS };
