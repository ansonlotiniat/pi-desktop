---
name: pi-desktop-feature-builder
description: Build or revise complete local Pi Desktop feature apps, including custom code review, diff, pull-request management, authenticated API tools, dashboards, and other sidebar functions. Use when the user asks an agent to add a Pi Desktop plugin or feature without modifying the Pi kernel or the Desktop core app.
---

# Build a Pi Desktop feature

Build the requested product surface as one independent feature folder. Keep Pi Desktop as host
and Pi as the sole agent/session kernel.

## Start

1. Read the workspace `AGENTS.md` and nearest `knowledge.md` when present.
2. Read [references/feature-host-api.md](references/feature-host-api.md).
3. Read [references/pi-desktop-feature.d.ts](references/pi-desktop-feature.d.ts) only when bridge
   types or Pi events are needed.
4. Read [references/feature.schema.json](references/feature.schema.json) when writing the manifest.
5. Copy [assets/feature-template](assets/feature-template) as the starting folder.

Use `<workspace>/.pi-desktop/features/<id>/` by default. Use
`~/.pi-desktop/features/<id>/` only when the user explicitly requests a global feature.

## Architecture

- Own the complete feature UI inside the self-contained `ui/index.html`.
- Put Git, API, parsing, filtering, and integration logic in the persistent JSONL service.
- Call `piDesktop.pi.prompt()` only after an explicit user action needs Pi reasoning.
- Use official Pi RPC through `piDesktop.pi`; do not store conversations or emulate Pi behavior.
- Own feature authentication. Prefer an authenticated CLI, feature storage, or a localhost OAuth
  callback. Never modify Pi provider credentials.
- Do not patch Desktop React/CSS for a feature request. If the requested capability needs a new
  host primitive, state the exact missing primitive instead of working around the boundary.

## UI contract

Build a real tool flow, not a demo page:

1. Load host context and deterministic data.
2. Render loading, empty, ready, and recoverable error states.
3. Keep pointer hover and keyboard selection synchronized.
4. Use readable text, visible focus, and controls at least 32px high.
5. Make the primary action explicit and return to chat with `navigate("chat")` when Pi continues
   the task.

The iframe cannot import Desktop components or read arbitrary local files. Bundle all frontend
CSS and JavaScript into the HTML entry. Avoid remote runtime dependencies.

## Service contract

Use namespaced methods such as `review.snapshot`, `pulls.list`, and `auth.status`. Reply to every
request exactly once. Write only JSONL protocol records to stdout and diagnostics to stderr.
Keep one service method focused; load large content such as diffs per item instead of returning
the entire repository in one response.

## Verify

Run only checks proportional to the feature:

1. Validate the manifest against the bundled schema.
2. Run `node --check service/main.mjs` for a Node service.
3. Exercise every primary method with one isolated JSONL fixture.
4. Render the UI with a mock `window.piDesktop` and test loading, success, empty, and error paths.
5. Tell the user the exact feature directory and verified main flow.

Do not use foreground GUI automation unless the user explicitly authorizes it.
