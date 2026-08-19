# Agent contract: build a Pi Desktop feature

Use this contract when a user asks for a complete feature such as code review, pull-request
management, issue triage, deployment control, or a custom authenticated tool. You do not need
to read the Pi Desktop source tree.

## Read first

Read these three files before coding:

1. `feature.schema.json`
2. `pi-desktop-feature.d.ts`
3. `template/`

For a production tool, inspect the closest installed official reference: Code Review/Code Diff for
local Git changes, PR Workspace for an authenticated CLI integration, or Project Map for bounded
local analysis. They demonstrate full-height workbenches, persistent JSONL services, clear
loading/empty/error states, and explicit handoffs to Pi.

## Build boundary

- Create one complete folder at `<workspace>/.pi-desktop/features/<id>/` for a project feature,
  or `~/.pi-desktop/features/<id>/` only when the user explicitly asks for a global feature.
- The feature owns its UI, deterministic logic, integration state, and authentication.
- Pi Desktop only hosts the frame, starts the optional service, stores feature JSON, and forwards
  official Pi RPC commands. Do not edit Desktop source or imitate Pi session behavior.
- Use `piDesktop.pi.prompt()` only for agent reasoning. Git, parsing, diffing, API calls, filters,
  and transformations belong in the service and should consume no model tokens.
- Never bundle a Pi executable or create a second conversation store.

## Package contract

```text
my-feature/
├── feature.json
├── ui/
│   └── index.html
└── service/
    └── main.mjs
```

The UI entry must be self-contained. Bundle scripts, styles, fonts, and images into the HTML.
The sandbox does not expose Desktop React components, CSS, Node APIs, or arbitrary local files.

Use namespaced service methods such as `review.snapshot`, `pulls.list`, and `auth.status`. Reply to
every request exactly once. Stdout is JSONL protocol only; diagnostics go to stderr.

## Product flow

Implement the smallest complete loop, not a page of disconnected buttons:

1. Load host context and deterministic data.
2. Show clear loading, empty, ready, and recoverable error states.
3. Let the user inspect or edit the data with keyboard and pointer controls.
4. Make the primary action explicit. If it needs Pi, call `pi.prompt()` only on that action.
5. Return to chat with `piDesktop.navigate("chat")` when the result continues in Pi.

Use at least 13px text, visible focus rings, 32px controls, and one selected state. Hover and
keyboard selection must resolve to the same active item. Prefer a dense tool layout over a
marketing page or a grid of decorative cards.

## Authentication

Choose one feature-owned pattern:

- Reuse an already authenticated CLI and expose account status in the UI.
- Ask for a token in the feature UI and store it with `piDesktop.storage`.
- Run a temporary localhost OAuth callback in the service and open the authorization URL with
  `piDesktop.openExternal()`.

Never read or modify Pi model-provider credentials. Do not put secrets in `feature.json`, service
arguments, stdout, or frontend source.

## Minimal verification

Before handing the feature to the user:

1. Validate `feature.json` against `feature.schema.json`.
2. Run `node --check service/main.mjs` when a Node service exists.
3. Send one JSONL request to each primary service method in an isolated fixture.
4. Open the UI in a mock host and verify loading, success, empty, and error rendering.
5. Reload Features in Pi Desktop and run the feature's main user flow once.

Do not add broad security audits, package installs, or full-repository tests unless the feature's
risk requires them. Tell the user the exact feature directory created and what was verified.
