# Pi Desktop

A macOS-only desktop GUI for the official [Pi coding agent](https://pi.dev/). The app is only a GUI: it launches the user's external Pi installation as one long-lived native TUI/kernel process and does not bundle, embed, or replace Pi.

## Run the built app

The current Apple Silicon build is at:

```text
src-tauri/target/release/bundle/macos/Pi Desktop.app
```

First-use flow:

1. Install Pi using one of the methods on [pi.dev](https://pi.dev/) and complete Pi's normal authentication or provider setup.
2. Open **Settings** and choose the project working directory. Set an explicit executable path if Pi is not discoverable from the app's environment.
3. Click **Connect Pi**. Pi Desktop starts that executable once in fullscreen TUI mode with an explicitly loaded Desktop bridge extension. It reports Connected only after the extension returns authoritative state through its versioned handshake.

For a keyless local endpoint, enter any non-empty placeholder key if the server ignores authentication. API keys are stored as plaintext in the app-owned settings file with Unix mode `0600`; the UI masks them and the Desktop bridge does not place them in process arguments or logs.

## v1 capabilities

- One resident external Pi process with a real PTY, native TUI, and versioned public-ExtensionAPI sideband handshake
- Streaming chat, steer/follow-up queues, abort, and new session
- Model and thinking-level selection
- Tool execution progress, context/session statistics, and raw event inspector
- Native **Pi default** tool behavior plus an opt-in Desktop-rendered **Ask before actions** gate using Pi's public extension hook
- Custom provider editor for API key + base URL
- Configurable Pi-compatible executable path; OMP is never selected implicitly
- Native slash commands and arbitrary extension TUI through the exact same live Pi process/session
- Feature Host API v1 for complete agent-authored sidebar applications with isolated custom UI, optional JSONL services, feature-owned auth/state, and an explicit Pi request bridge
- Four optional, uninstalled official feature packs: Code Review, Code Diff, PR Workspace, and Project Map

Pi Desktop does not keep a separate conversation database and does not pass `--no-session` or a private `--session-dir`. Pi therefore owns the session files in its normal location. From the same project working directory, `pi -r` can find conversations created through the GUI.

Desktop provides a Pi-owned historical-session browser, but Pi still performs every session switch. Provider login, tree/fork and arbitrary extension components remain available through the embedded native TUI. Kernel installation, updates, and rollback remain user-owned; unknown forwarded Pi events stay visible in the inspector.

## Development

Requirements: macOS on Apple Silicon, Node.js, npm, and Rust.

```bash
npm install
npm run tauri dev
```

Feature authors do not need the Desktop source tree. Start with the short
[Feature Host SDK](docs/feature-sdk/README.md) and its uninstalled scaffold. Pi Desktop scans
`<workspace>/.pi-desktop/features/` and `~/.pi-desktop/features/` but never downloads or silently
installs a feature.

Focused checks and release app build:

```bash
npm run build
(cd src-tauri && cargo check --lib)
npm run tauri build -- --bundles app
```
