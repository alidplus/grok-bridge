# Grok Bridge

> **Unofficial — not affiliated with Anysphere (Cursor) or xAI (Grok).**
> A free, open-source community extension.

Grok Bridge connects Grok Bots and Cursor agents. It adds a panel inside Cursor where you can
watch, read and steer agents started through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
(`@cursor/sdk`). Agents run locally against your folders; nothing runs in the cloud.

SDK agents don't appear in Cursor's own agents history pane. Grok Bridge fills that gap.

## Features

- **Agents list:** every local SDK agent for a folder, with name, status, id and last-modified time.
- **Conversation view:** click an agent to read its turns: your prompts, assistant text, thinking and tool calls.
- **Prompt box:** start a **new agent** or **continue** the selected one. Assistant text and
  `[tool] name status` lines stream into the panel live, and the list refreshes when the run ends.
- **Grok by default:** new prompts use `grok-4.5`. You can change it per prompt or in settings.
- **Activity Bar view** plus the **Grok Bridge: Open** command, which opens the panel as an editor tab.
- **Small and cross-platform:** the extension ships no binaries. On first use it installs a pinned
  `@cursor/sdk` into its own storage folder with your Node's npm. **Grok Bridge: Reinstall SDK** repairs that install.

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
   cursor --install-extension grok-bridge-0.1.1.vsix
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
| `grokBridge.sdkDir` | *(managed)* | Optional folder whose `node_modules` contains a different `@cursor/sdk`. When it's empty, Grok Bridge uses the SDK it installed itself. |

## Usage

1. Click the **Grok Bridge** icon in the Activity Bar, or run **Grok Bridge: Open**.
2. The **cwd** box shows the current folder. Change it and press Enter, or press ⟳, to list agents for another folder.
3. Click an agent to read its conversation.
4. Type a prompt, choose **New agent** or **Continue selected**, then press **Send** (or Ctrl/Cmd+Enter).

Logs and errors go to the **Grok Bridge** output channel (View → Output).

## Safety

Local SDK agents run **without approval prompts**. They can read and edit files and run shell commands
in the working folder. Point `cwd` only at folders you're willing to let an agent change. Review the
changes with git before you commit or push. Usage is billed to your Cursor account like normal agent use.

## How it works

`sdk-installer.js` finds Node >= 22.13 and installs the pinned `@cursor/sdk` into the extension's global storage
(`<globalStorage>/alidplus.grok-bridge/sdk`). It installs into a temporary folder first and swaps it in, so a failed install
never leaves a broken SDK behind. `extension.js` then starts `helper.mjs` on that Node. The two talk in JSON lines over stdio. The helper
calls `@cursor/sdk` (`Agent.list`, `Agent.messages.list`, `Agent.create`/`Agent.resume` + `send`/`stream`)
and streams events back to the webview.

## Development

```bash
npm ci
node test/install-sdk.mjs --cwd /path/to/a/folder   # real SDK install into Cursor's globalStorage, then list agents
npx @vscode/vsce package                            # build the .vsix
```

Release steps are in [PUBLISHING.md](PUBLISHING.md).

## License

[MIT](LICENSE) © 2026 Ali Ghorbani. "Cursor" and "Grok" are trademarks of their respective owners.
