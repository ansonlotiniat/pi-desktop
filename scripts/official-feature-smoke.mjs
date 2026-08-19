import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectMapService = join(
  projectRoot,
  "src-tauri/resources/starter-features/project-map/service/main.mjs",
);
const prWorkspaceService = join(
  projectRoot,
  "src-tauri/resources/starter-features/pr-workspace/service/main.mjs",
);
const bridgeSource = join(projectRoot, "src-tauri/resources/pi-desktop-bridge.mjs");

class ServiceClient {
  constructor(entry, env) {
    this.sequence = 0;
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(process.execPath, [entry], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error.message));
        else pending.resolve(response.result);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
  }

  request(method, params = {}) {
    this.sequence += 1;
    const id = `request-${this.sequence}`;
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async close() {
    this.child.stdin.end();
    const code = await new Promise((resolveExit) => this.child.once("exit", resolveExit));
    assert.equal(code, 0, this.stderr || "Feature service did not exit cleanly.");
  }
}

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function smokeProjectMap(root) {
  const workspace = join(root, "project-map-fixture");
  await writeFixture(join(workspace, "package.json"), '{"name":"fixture","type":"module"}\n');
  await writeFixture(
    join(workspace, "src/index.ts"),
    'import { helper } from "../lib/helper";\nconsole.log(helper());\n',
  );
  await writeFixture(join(workspace, "lib/helper.ts"), 'export const helper = () => "ready";\n');
  await writeFixture(join(workspace, "README.md"), "# Fixture\n\nProject map smoke test.\n");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });

  const client = new ServiceClient(projectMapService, {
    PI_DESKTOP_WORKSPACE: workspace,
  });
  const snapshot = await client.request("project.scan");
  assert.equal(snapshot.scan.source, "git");
  assert.equal(snapshot.totals.files, 4);
  assert(snapshot.modules.some((module) => module.name === "src"));
  assert(snapshot.modules.some((module) => module.name === "lib"));
  assert(snapshot.edges.some((edge) => edge.from === "src" && edge.to === "lib"));
  assert(snapshot.entryPoints.some((entry) => entry.path === "package.json"));

  const file = await client.request("project.file", { path: "src/index.ts" });
  assert.equal(file.language, "TypeScript");
  assert.match(file.content, /console\.log/);
  await assert.rejects(
    client.request("project.file", { path: "../outside.txt" }),
    /outside this workspace/,
  );
  await client.close();
}

async function smokePrWorkspace(root) {
  const workspace = join(root, "pr-workspace-fixture");
  const fakeGh = join(root, "fake-gh.mjs");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const same = (...value) => value.every((part, index) => args[index] === part);
if (args[0] === "--version") console.log("gh version 9.9.9");
else if (same("auth", "status")) process.exit(0);
else if (same("repo", "view")) console.log(JSON.stringify({ nameWithOwner: "pi/desktop", url: "https://github.com/pi/desktop", defaultBranchRef: { name: "main" } }));
else if (same("pr", "list")) console.log(JSON.stringify([{ number: 17, title: "Add project map", url: "https://github.com/pi/desktop/pull/17", state: "OPEN", isDraft: false, author: { login: "agent" }, updatedAt: "2026-08-13T10:00:00Z", headRefName: "project-map", baseRefName: "main", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }], additions: 42, deletions: 3, changedFiles: 2 }]));
else if (same("pr", "view")) console.log(JSON.stringify({ number: 17, title: "Add project map", body: "Local deterministic map", url: "https://github.com/pi/desktop/pull/17", state: "OPEN", isDraft: false, author: { login: "agent" }, createdAt: "2026-08-13T09:00:00Z", updatedAt: "2026-08-13T10:00:00Z", headRefName: "project-map", baseRefName: "main", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", additions: 42, deletions: 3, changedFiles: 2, files: [{ path: "src/map.ts", additions: 40, deletions: 2 }, { path: "README.md", additions: 2, deletions: 1 }], reviews: [], comments: [], commits: [{}], statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] }));
else if (same("pr", "diff")) process.stdout.write("diff --git a/src/map.ts b/src/map.ts\\nindex 111..222 100644\\n--- a/src/map.ts\\n+++ b/src/map.ts\\n@@ -1 +1,2 @@\\n-old\\n+new\\n+map\\ndiff --git a/README.md b/README.md\\n--- a/README.md\\n+++ b/README.md\\n@@ -1 +1 @@\\n-old\\n+new\\n");
else { console.error(\`Unexpected gh arguments: \${args.join(" ")}\`); process.exit(2); }
`,
    "utf8",
  );
  await chmod(fakeGh, 0o755);

  const client = new ServiceClient(prWorkspaceService, {
    GH_PATH: fakeGh,
    PI_DESKTOP_WORKSPACE: workspace,
  });
  const list = await client.request("pr.list", { filter: "open" });
  assert.equal(list.environment.repository.nameWithOwner, "pi/desktop");
  assert.equal(list.pullRequests.length, 1);
  assert.equal(list.pullRequests[0].checkSummary.passed, 1);

  const detail = await client.request("pr.detail", { number: 17 });
  assert.equal(detail.files.length, 2);
  assert.equal(detail.headRefName, "project-map");

  const patch = await client.request("pr.patch", { number: 17, path: "src/map.ts" });
  assert.match(patch.patch, /\+map/);
  assert.doesNotMatch(patch.patch, /README\.md/);
  await client.close();
}

function recordStream(socket) {
  const records = [];
  const waiters = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const record = JSON.parse(line);
      const index = waiters.findIndex((waiter) => waiter.predicate(record));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(record);
      } else {
        records.push(record);
      }
    }
  });
  return (predicate, timeoutMs = 4_000) => {
    const index = records.findIndex(predicate);
    if (index >= 0) return Promise.resolve(records.splice(index, 1)[0]);
    return new Promise((resolveRecord, reject) => {
      const waiter = { predicate, resolve: resolveRecord, timeout: null };
      waiter.timeout = setTimeout(() => {
        const waitingIndex = waiters.indexOf(waiter);
        if (waitingIndex >= 0) waiters.splice(waitingIndex, 1);
        reject(new Error("Timed out waiting for Pi Desktop bridge record."));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
}

async function locatePiPackage() {
  const executable = execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8" }).trim();
  const target = await realpath(executable);
  return resolve(dirname(target), "..");
}

async function smokePermissionBridge(root) {
  const packageRoot = await locatePiPackage();
  const packageDependencies = join(packageRoot, "node_modules/@earendil-works");
  const bridgeRoot = join(root, "bridge");
  const scope = join(bridgeRoot, "node_modules/@earendil-works");
  await mkdir(scope, { recursive: true });
  await copyFile(bridgeSource, join(bridgeRoot, "pi-desktop-bridge.mjs"));
  await symlink(packageRoot, join(scope, "pi-coding-agent"));
  await symlink(join(packageDependencies, "pi-ai"), join(scope, "pi-ai"));

  const socketPath = join(root, "bridge.sock");
  let connection;
  const server = net.createServer((socket) => { connection = socket; });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolveListen);
  });

  process.env.PI_DESKTOP_BRIDGE_SOCKET = socketPath;
  process.env.PI_DESKTOP_TOOL_ACCESS_MODE = "ask";
  const handlers = new Map();
  const pi = {
    registerCommand() {},
    on(type, handler) {
      const values = handlers.get(type) || [];
      values.push(handler);
      handlers.set(type, values);
    },
    getThinkingLevel: () => "low",
    getCommands: () => [],
    sendUserMessage() {},
    setModel: async () => true,
    setThinkingLevel() {},
    setSessionName() {},
  };
  const context = {
    cwd: join(root, "workspace"),
    model: null,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 0, contextWindow: 128_000, percent: 0 }),
    abort() {},
    modelRegistry: { getAvailable: () => [], find: () => null },
    sessionManager: {
      buildContextEntries: () => [],
      getSessionFile: () => join(root, "session.jsonl"),
      getSessionId: () => "smoke-session",
      getSessionName: () => "Smoke session",
    },
    signal: new AbortController().signal,
  };

  const imported = await import(`${pathToFileURL(join(bridgeRoot, "pi-desktop-bridge.mjs")).href}?smoke=1`);
  imported.default(pi);
  await handlers.get("session_start")[0]({ reason: "startup" }, context);
  while (!connection) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  const nextRecord = recordStream(connection);
  const ready = await nextRecord((record) => record.type === "bridge_ready");
  assert.equal(ready.toolAccess.mode, "ask");

  connection.write(`${JSON.stringify({ id: "access", type: "get_tool_access" })}\n`);
  const access = await nextRecord((record) => record.id === "access");
  assert.equal(access.data.mode, "ask");

  const toolHandler = handlers.get("tool_call")[0];
  const allowResult = toolHandler(
    { toolCallId: "bash-1", toolName: "bash", input: { command: "rg -n TODO src" } },
    context,
  );
  const bashRequest = await nextRecord((record) => record.type === "tool_permission_request");
  assert.equal(bashRequest.input.command, "rg -n TODO src");
  connection.write(`${JSON.stringify({ id: "allow", type: "resolve_tool_permission", requestId: bashRequest.requestId, decision: "allow" })}\n`);
  await nextRecord((record) => record.id === "allow");
  assert.equal(await allowResult, undefined);

  assert.equal(
    await toolHandler({ toolCallId: "read-1", toolName: "read", input: { path: "README.md" } }, context),
    undefined,
  );

  const denyResult = toolHandler(
    { toolCallId: "edit-1", toolName: "edit", input: { path: "src/App.tsx", oldText: "old", newText: "new" } },
    context,
  );
  const editRequest = await nextRecord((record) => record.type === "tool_permission_request");
  connection.write(`${JSON.stringify({ id: "deny", type: "resolve_tool_permission", requestId: editRequest.requestId, decision: "deny" })}\n`);
  await nextRecord((record) => record.id === "deny");
  assert.deepEqual(await denyResult, { block: true, reason: "Blocked by the user in Pi Desktop." });

  await handlers.get("session_shutdown")[0]({ reason: "shutdown" });
  connection.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
  delete process.env.PI_DESKTOP_BRIDGE_SOCKET;
  delete process.env.PI_DESKTOP_TOOL_ACCESS_MODE;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-desktop-smoke-"));
try {
  await smokeProjectMap(temporaryRoot);
  await smokePrWorkspace(temporaryRoot);
  await smokePermissionBridge(temporaryRoot);
  process.stdout.write("Official feature and permission bridge smoke tests passed.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
