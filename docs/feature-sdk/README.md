# Pi Desktop Feature Host API v1

Pi Desktop feature packs are complete local applications. A feature owns its frontend,
business logic, API integrations, state, and authentication. Pi Desktop only discovers it,
adds its navigation entry, runs its optional service, and provides a small bridge to the
workspace and the official Pi kernel.

## Discovery

Pi Desktop scans two explicit locations:

- Project: `<workspace>/.pi-desktop/features/<feature-id>/feature.json`
- Global: `~/.pi-desktop/features/<feature-id>/feature.json`

A project feature with the same `id` overrides the global feature. Pi Desktop never downloads
or silently installs a feature. The Plugins screen includes four app-bundled official packs:
`code-review`, `code-diff`, `pr-workspace`, and `project-map`. Choosing **Install** explicitly copies a pack into the global
discovery directory. Until then it is catalog metadata only. Official packs carry a version and
can be updated explicitly; Pi Desktop refuses to overwrite a custom feature with the same ID.
When migrating an older unversioned official pack, it keeps the prior folder under
`~/.pi-desktop/feature-backups/`.

## Package shape

```text
my-feature/
├── feature.json
├── ui/
│   └── index.html
└── service/
    └── main.mjs
```

`ui/index.html` is the feature's complete application. React, Vue, Svelte, or vanilla HTML are
all valid choices. API v1 requires the final entry to be self-contained: bundle JavaScript,
CSS, fonts, and images into the HTML instead of depending on relative asset files.

The frontend runs in its own sandboxed frame. It cannot import Pi Desktop React components or
change host CSS. Pi Desktop injects `window.piDesktop` before the feature's own scripts run;
use [`pi-desktop-feature.d.ts`](./pi-desktop-feature.d.ts) for editor types.

## Manifest

```json
{
  "apiVersion": 1,
  "id": "my-feature",
  "name": "My feature",
  "version": "0.1.0",
  "publisher": "Your name",
  "description": "A complete agent-built tool.",
  "icon": "+",
  "order": 100,
  "ui": { "entry": "ui/index.html" },
  "service": {
    "command": "node",
    "args": ["service/main.mjs"],
    "env": { "OPTIONAL_NON_SECRET_SETTING": "value" }
  }
}
```

`service` is optional. `command: "node"` resolves the Node executable beside the configured Pi
installation first, which also works when macOS launches Desktop without the Terminal PATH.
Other command names, absolute paths, or feature-relative executable paths are allowed.

## Frontend bridge

```js
const context = await window.piDesktop.getContext();

const result = await window.piDesktop.service.request("review.load", {
  base: "main"
});

await window.piDesktop.storage.set("account", { login: "anson" });
const account = await window.piDesktop.storage.get("account");

const state = await window.piDesktop.pi.request({ type: "get_state" });
const sameState = await window.piDesktop.pi.getState();
const stopPiEvents = window.piDesktop.pi.onEvent((event) => {
  // Streaming and extension events from the existing resident Pi process.
});

await window.piDesktop.openExternal("https://github.com/login");
await window.piDesktop.navigate("chat");

await window.piDesktop.pi.prompt("Review the selected files for correctness regressions.");
```

Deterministic work such as Git operations, diff parsing, PR listing, API calls, and local state
belongs in the feature service and consumes no model tokens. Use `pi.prompt()` only after an
explicit user action genuinely needs agent reasoning. `pi.request()` remains available for other
official Pi RPC commands.

## Service JSONL protocol

Pi Desktop keeps one service process alive per feature and workspace. Every stdin record is a
single LF-terminated JSON object:

```json
{
  "type": "request",
  "id": "my-feature-1",
  "method": "review.load",
  "params": {},
  "context": {
    "featureId": "my-feature",
    "workspace": "/absolute/workspace"
  }
}
```

Reply on stdout with exactly one JSONL response:

```json
{"type":"response","id":"my-feature-1","result":{"files":[]}}
```

or:

```json
{"type":"response","id":"my-feature-1","error":{"message":"Not a Git repository"}}
```

A record without a request `id` is forwarded to the frontend as a service event:

```json
{"type":"event","event":"review.progress","data":{"completed":4,"total":10}}
```

Subscribe with `window.piDesktop.service.onEvent(handler)`. Stdout is reserved for protocol
records; write diagnostics to stderr.

The service receives `PI_DESKTOP_FEATURE_ID`, `PI_DESKTOP_FEATURE_ROOT`, and
`PI_DESKTOP_WORKSPACE` environment variables.

## Authentication

Authentication belongs to the feature:

- Reuse an authenticated CLI when practical.
- Render any token/account UI inside the feature frontend.
- Store JSON values through `piDesktop.storage`; the host-owned file is written with mode `0600`.
- For OAuth, the service may run a temporary localhost callback and the frontend may open the
  authorization URL with `piDesktop.openExternal()`.

Model-provider login remains owned by Pi and must not be recreated by a Desktop feature.

## Development loop

Start from [`template/`](./template/), change the ID and feature code, then copy the resulting
feature directory into one of the explicit discovery paths. The reload control in Pi Desktop
rescans the manifest, reloads the entire frontend, and restarts that feature's service.
