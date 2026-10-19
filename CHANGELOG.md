# Changelog

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
