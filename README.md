# Grok Bridge

> **Unofficial — not affiliated with Anysphere (Cursor) or xAI (Grok).**
> A free, open-source community extension.

Grok Bridge connects Grok Bots and Cursor agents. It adds a panel inside Cursor where you can
watch, read and steer agents started through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
(`@cursor/sdk`). Agents run locally against your folders; nothing runs in the cloud.

SDK agents don't appear in Cursor's own agents history pane. Grok Bridge fills that gap.

## Features

- **Cursor-style chat:** a top bar with the agent title, **+** for a new agent and a **history** button.
  Your prompts appear as bubbles, replies render as markdown (code, lists, tables, links), tool calls and
  thinking fold into one collapsed line, and each turn shows **Worked for Xs**.
- **Composer:** Enter sends, Shift+Enter adds a line, the model pill picks the model (Grok models first,
  `grok-4.5` by default), and the send button becomes **Stop** while the agent works.
- **History:** every local SDK agent for a folder, newest first, with a live marker on running agents.
- **MCP server for Grok Bots:** a small local MCP endpoint lets a Grok Bot list, start, prompt, read and cancel
  Cursor agents. Runs a bot starts stream into the panel live, just like your own.
- **Activity Bar view** plus the **Grok Bridge: Open** command, which opens the panel as an editor tab.
- **Small and cross-platform:** the extension ships no binaries and has no runtime npm dependencies. On first use it
  installs a pinned `@cursor/sdk` into its own storage folder with your Node's npm. **Grok Bridge: Reinstall SDK** repairs that install.

## MCP for Grok Bots

Grok Bridge runs an MCP server (Streamable HTTP, JSON responses) on `http://127.0.0.1:7457/mcp`. It listens on
localhost only and every request needs a bearer token. Run **Grok Bridge: Copy MCP Config** and give the result to your bot:

```json
{
  "mcpServers": {
    "grok-bridge": {
      "url": "http://127.0.0.1:7457/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The same config is written to `<globalStorage>/alidplus.grok-bridge/mcp.json` (readable only by you), so local scripts can find it.
**Grok Bridge: Regenerate MCP Token** replaces the token; old configs stop working.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `list_agents` | `cwd?` | Agents for a folder, with `running` flags. |
| `create_agent` | `prompt`, `model?`, `cwd?`, `wait?`, `timeout_s?` | Starts a new agent. With `wait` (default) it returns the final reply. |
| `send_prompt` | `agent_id`, `prompt`, `wait?`, `timeout_s?`, `model?` | Continues an agent's conversation. |
| `get_messages` | `agent_id` | The conversation as plain text: prompts, replies and tool steps. |
| `cancel_run` | `agent_id` | Stops the agent's current run. |

A run that outlasts `timeout_s` (600 by default) keeps going; the tool returns `"status": "running"`, and the bot can poll
`get_messages`. Quick check with curl:

```bash
curl -s http://127.0.0.1:7457/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The server lives in the Cursor window that started first. Another window that finds the port taken shows that in the
history view, and you can pick a different `grokBridge.mcpPort`. A bot on another machine can't reach `127.0.0.1`;
it needs to run on the same computer or use a tunnel you control.

## Requirements

- **Node.js >= 22.13 with npm.** The SDK needs `node:sqlite`, and Cursor's built-in extension host may be older,
  so the SDK runs in a separate helper process on your own Node. Grok Bridge looks for Node on PATH and in nvm, fnm,
  Volta, Homebrew and system locations, or uses `grokBridge.nodePath`.
- **Internet access on first use**, so npm can download `@cursor/sdk` (about 50 MB installed) into Grok Bridge's global storage.
- **A Cursor SDK login.** One option is to run `Cursor.auth.login()` once; it stores a key in `~/.cursor/sdk/auth.json`.
  The other is to set `CURSOR_API_KEY` in the environment Cursor starts with.
- Cursor (or another VS Code-compatible editor, version 1.80 or later).

## Setup

1. Install the extension from a `.vsix` file:
   ```bash
   cursor --install-extension grok-bridge-0.2.0.vsix
   ```
2. Log in to the Cursor SDK once, if you haven't already:
   ```bash
   mkdir -p /tmp/cursor-login && cd /tmp/cursor-login && npm init -y >/dev/null && npm i @cursor/sdk
   node --input-type=module -e 'import {Cursor} from "@cursor/sdk"; console.log(await Cursor.auth.login({onLoginUrl: console.log}))'
   ```
3. Reload the window: run **Developer: Reload Window** from the Command Palette.
4. Open the panel. The first time, a notification shows the SDK being installed; this takes about 20 seconds.
   If it fails, check **View → Output → Grok Bridge**, fix the cause (Node, network or proxy), then run
   **Grok Bridge: Reinstall SDK**.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `grokBridge.nodePath` | *(auto)* | Node >= 22.13 binary. Leave empty to auto-detect it from PATH, nvm, fnm, volta or Homebrew. |
| `grokBridge.defaultModel` | `grok-4.5` | Model for new prompts. |
| `grokBridge.cwd` | *(workspace)* | Override the agents' working folder. |
| `grokBridge.mcpEnabled` | `true` | Run the local MCP server. |
| `grokBridge.mcpPort` | `7457` | MCP server port (binds to 127.0.0.1). |
| `grokBridge.sdkDir` | *(managed)* | Optional folder whose `node_modules` contains a different `@cursor/sdk`. When it's empty, Grok Bridge uses the SDK it installed itself. |

## Usage

1. Click the **Grok Bridge** icon in the Activity Bar, or run **Grok Bridge: Open**.
2. Type in the box at the bottom and press **Enter** to start a new agent in the workspace folder.
   Keep typing in the same chat to continue that agent.
3. Press the **history** (clock) button to see the folder's agents. Click one to open it. Change the **Folder** field and press Enter to list another folder.
4. Press **+** for a fresh agent. Press the round button (it turns into a square) to stop a running agent.

Logs and errors go to the **Grok Bridge** output channel (View → Output).

## Safety

Local SDK agents run **without approval prompts**. They can read and edit files and run shell commands
in the working folder. Point `cwd` only at folders you're willing to let an agent change. Review the
changes with git before you commit or push. Usage is billed to your Cursor account like normal agent use.

## How it works

`sdk-installer.js` finds Node >= 22.13 and installs the pinned `@cursor/sdk` into the extension's global storage
(`<globalStorage>/alidplus.grok-bridge/sdk`). It installs into a temporary folder first and swaps it in, so a failed install
never leaves a broken SDK behind. `extension.js` then starts `helper.mjs` on that Node. The two talk in JSON lines over stdio, and the helper
calls `@cursor/sdk` (`Agent.list`, `Agent.messages.list`, `Agent.create`/`Agent.resume` + `send`/`stream`, `run.cancel`).

Every run, whether it came from the panel or from MCP, goes through one hub in `extension.js` that streams its events to all open panels.
`mcp.js` is a hand-written MCP server (about 150 lines, Node's `http` only) that maps the tools above onto that hub.

```
Grok Bot ──MCP/HTTP──▶ mcp.js ─┐
                               ├─▶ hub (extension.js) ──JSON lines──▶ helper.mjs ──▶ @cursor/sdk ──▶ local agent
Panel (webview) ──postMessage──┘          └── live events ──▶ every open panel
```

## Development

```bash
npm ci
node test/install-sdk.mjs --cwd /path/to/a/folder   # real SDK install into Cursor's globalStorage, then list agents
node test/host.js --cwd /path/to/a/folder           # run extension.js outside Cursor (fake vscode) to test MCP with curl
node test/preview.mjs chat                          # write .test-storage/preview-chat.html to look at the panel in a browser
npx @vscode/vsce package                            # build the .vsix
```

Release steps are in [PUBLISHING.md](PUBLISHING.md).

## License

[MIT](LICENSE) © 2026 Ali Ghorbani. "Cursor" and "Grok" are trademarks of their respective owners.
