# Pi Desktop project instructions

## Product and kernel boundary

- Pi Desktop is a GUI and control plane for Pi. It must not implement, emulate, or replace Pi kernel behavior.
- Do not bundle, download, embed, or silently substitute a Pi kernel. Start only an external Pi-compatible executable installed or explicitly selected by the user. Use either official RPC or a Desktop-owned bridge loaded through Pi's public ExtensionAPI; the bridge may expose state/control transport but must not reproduce kernel behavior.
- Official Pi is the automatic-discovery target. OMP or another compatible kernel may be used only when the user explicitly configures its executable path; never select it as an implicit fallback.
- Pi is the source of truth for messages, tools, models, context, sessions, trees, forks, clones, compaction, and exports. Use Pi's public RPC/ExtensionAPI contracts or its native TUI instead of recreating those operations in the GUI.
- Do not create an app-owned conversation/history database or reinterpret Pi session JSONL as an alternative session engine. Preserve Pi's normal session persistence: do not pass `--no-session` or a private `--session-dir`, so `pi -r` from the same project can find GUI-created sessions.
- Report Connected only after the spawned executable successfully completes an authoritative handshake: Pi RPC `get_state`, or the versioned Desktop bridge returning state obtained from public ExtensionAPI/session-manager reads. If an operation is not exposed by either supported public contract, record the capability gap instead of silently reimplementing Pi internals.

## Disk-space handling

- If a build, test, install, or other task encounters insufficient disk space, stop immediately and ask the user how to proceed.
- Do not delete caches or build artifacts, move build output to another volume, or perform any other space-recovery action unless the user explicitly authorizes it in the current conversation.

## Non-disruptive app verification

- Run packaged-app verification headlessly or in background processes by default. A request to test the app does not authorize taking foreground focus or competing for the user's mouse and keyboard.
- Do not launch or operate Orca, Computer Use, AppleScript UI automation, Accessibility actions, or test windows unless the user explicitly says foreground control is allowed in the current conversation.
- If foreground permission is granted and then withdrawn, stop all UI actions immediately. Continue with an isolated PTY/bridge harness or another background method, and do not close or manipulate the user's current windows.
