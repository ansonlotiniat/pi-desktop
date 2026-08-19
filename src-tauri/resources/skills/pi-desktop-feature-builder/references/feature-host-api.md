# Feature Host API v1

## Package

```text
feature-id/
├── feature.json
├── ui/index.html
└── service/main.mjs
```

Project discovery: `<workspace>/.pi-desktop/features/<feature-id>/feature.json`

Global discovery: `~/.pi-desktop/features/<feature-id>/feature.json`

The final HTML entry must be self-contained. `service` is optional.

## Frontend bridge

```js
const context = await window.piDesktop.getContext();
const data = await window.piDesktop.service.request("domain.load", { page: 1 });

await window.piDesktop.storage.set("account", { login: "user" });
const account = await window.piDesktop.storage.get("account");

await window.piDesktop.pi.prompt("Review the selected changes.");
const state = await window.piDesktop.pi.getState();
const stop = window.piDesktop.pi.onEvent((event) => {});

await window.piDesktop.openExternal("https://example.com/login");
await window.piDesktop.navigate("chat");
```

`context.workspace.cwd` is the selected Desktop workspace. Context also includes feature metadata,
the connected external Pi kernel/state, and the color scheme.

## JSONL service

Pi Desktop keeps one service alive per feature and workspace. It sends one LF-terminated request:

```json
{"type":"request","id":"feature-1","method":"domain.load","params":{},"context":{"featureId":"feature-id","workspace":"/absolute/workspace"}}
```

Reply exactly once:

```json
{"type":"response","id":"feature-1","result":{"items":[]}}
```

or:

```json
{"type":"response","id":"feature-1","error":{"message":"Readable error"}}
```

Send a service event without a request ID:

```json
{"type":"event","event":"domain.progress","data":{"completed":4,"total":10}}
```

The service receives `PI_DESKTOP_FEATURE_ID`, `PI_DESKTOP_FEATURE_ROOT`, and
`PI_DESKTOP_WORKSPACE`. Stdout is reserved for protocol data.

## Authentication

Reuse an authenticated CLI when possible. Otherwise store feature-owned JSON with
`piDesktop.storage`, or run a localhost OAuth callback in the service and open the authorization
URL with `openExternal()`. Do not access Pi model-provider credentials.
