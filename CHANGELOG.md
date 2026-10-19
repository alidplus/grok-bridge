# Changelog

## 0.1.0 — 2026-10-19

- First release as **Grok Bridge**, rebranded from the internal "SDK Agents" prototype.
- Activity Bar view and the `Grok Bridge: Open` command.
- Lists local Cursor SDK agents per folder and shows their conversations.
- Prompts can start a new agent or continue an existing one, with live streaming of text and tool calls.
- Bundles `@cursor/sdk` and runs it in a Node >= 22.13 helper, which is auto-detected or set with `grokBridge.nodePath`.
- `grok-4.5` is the default model.
