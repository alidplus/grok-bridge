# Changelog

## 0.2.1 — 2026-10-19

Security review fixes:

- MCP folders are checked: `cwd` is resolved with `realpath` and must be inside an open workspace folder or the new
  `grokBridge.allowedRoots`. This applies to `create_agent`, `send_prompt`, `list_agents` and `get_messages`.
- The MCP token moved from globalState to SecretStorage. It is migrated once and the old key is deleted.
- `mcp.json` is now opt-in (`grokBridge.mcpWriteConfigFile`, default off) and written atomically: folder `700`, temp file `600`, then rename.
  When the setting is off, a file left by 0.2.0 is removed.
- `tools/call` is no longer allowed inside JSON-RPC batches, and batches hold at most 10 messages. New `grokBridge.mcpMaxRuns`
  (default 3) caps concurrent MCP runs, and `timeout_s` is capped at 1800.
- The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. Any request with an `Origin` header is refused.
- Internal errors return a generic 500 message; the details go to the log.
- README: the token means full code execution as you, and agent output is untrusted (prompt injection).

UX review fixes:

- Screen readers: the conversation is no longer a live region. A hidden status element announces only when a reply starts and finishes.
- Stop works while a new agent is still starting ("Starting…"), and **Escape** stops a run.
- Failed and cancelled turns show their "Worked for" line in the error colour.
- Font sizes follow the editor settings: `--vscode-font-size` for text and `--vscode-editor-font-size` for code.
- Code blocks get a **Copy** button that appears on hover.
- Until the model list loads, the model picker shows only the configured default model.
- A send error now clears only the run that sent it, matched by its ticket.
- User messages are shown as plain text. Long ones fold to 8 lines with **Show more**.
- High-contrast themes show dashed outlines on hover.

## 0.2.0 — 2026-10-19

- **MCP server for Grok Bots.** A hand-written MCP endpoint (Streamable HTTP, JSON responses, no new dependencies) on
  `http://127.0.0.1:7457/mcp` with a bearer token. It offers the tools `list_agents`, `create_agent`, `send_prompt`, `get_messages` and `cancel_run`.
  New commands: **Copy MCP Config** and **Regenerate MCP Token**. New settings: `grokBridge.mcpEnabled` and `grokBridge.mcpPort`.
- **Runs from any source show live.** One hub streams every run, from the panel or from MCP, to all open panels.
  When a bot starts a run, the panel follows it in a fresh chat, or shows a notice with a **View** button.
- **New chat UI, modeled on Cursor's agent chat.** It has a top bar (title, new, history), prompt bubbles, markdown replies,
  collapsed tool and thinking steps, **Worked for Xs**, a composer with a model pill and send/stop, empty states and inline errors.
  Fonts come from the editor theme: the UI font at 13px for text and the editor font for code.
- Helper: `cancel` and `models` commands, thinking, status and tool-detail events, per-turn durations, and running flags in the list.
- Dev tools: `test/host.js` runs the extension outside Cursor for curl tests, and `test/preview.mjs` renders the panel in a browser.

## 0.1.1 — 2026-10-19

- **Cross-platform:** `@cursor/sdk` is no longer bundled. On first use, or when the SDK is missing or outdated, a pinned
  version (1.0.38) is installed into the extension's global storage with the npm of the detected Node, and a progress notification is shown.
  The vsix is now small and contains no platform-specific binaries.
- New command **Grok Bridge: Reinstall SDK**.
- Clearer errors when no Node >= 22.13 is found, when `grokBridge.nodePath` is invalid, or when the npm install fails.
- Node detection now also checks fnm on macOS and the Windows install locations (Program Files, nvm-windows).
- Publisher set to `alidplus`; added repository, bugs and homepage links (github.com/alidplus/grok-bridge).
- Added CI (package and upload the vsix) and Open VSX Trusted Publishing workflows, plus PUBLISHING.md.

## 0.1.0 — 2026-10-19

- First release as **Grok Bridge**, rebranded from the internal "SDK Agents" prototype.
- Activity Bar view and the `Grok Bridge: Open` command.
- Lists local Cursor SDK agents per folder and shows their conversations.
- Prompts can start a new agent or continue an existing one, with live streaming of text and tool calls.
- Bundles `@cursor/sdk` and runs it in a Node >= 22.13 helper, which is auto-detected or set with `grokBridge.nodePath`.
- `grok-4.5` is the default model.
