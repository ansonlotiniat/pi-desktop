import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import readline from "node:readline";

const workspace = process.env.PI_DESKTOP_WORKSPACE || process.cwd();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const maxBuffer = 16 * 1024 * 1024;
const maxDiffBytes = 2 * 1024 * 1024;
const maxFiles = 500;

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function gitResult(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      },
    );
  });
}

async function git(args, allowedCodes = [0]) {
  const result = await gitResult(args);
  if (!allowedCodes.includes(result.code)) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail || `Git exited with code ${result.code}.`);
  }
  return result.stdout;
}

function normalizeScope(value) {
  return value === "staged" || value === "commit" ? value : "working";
}

async function repositoryContext() {
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  const [branchResult, headResult] = await Promise.all([
    gitResult(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitResult(["rev-parse", "--short", "HEAD"]),
  ]);
  return {
    root,
    branch: branchResult.code === 0 ? branchResult.stdout.trim() : "detached HEAD",
    head: headResult.code === 0 ? headResult.stdout.trim() : null,
    hasHead: headResult.code === 0,
  };
}

function diffCommand(scope, format, path, hasHead) {
  const common = ["--no-ext-diff", "--no-color", "--no-renames"];
  const tail = path ? ["--", path] : ["--"];
  if (scope === "commit") {
    return ["show", "--format=", ...common, format, "HEAD", ...tail];
  }
  if (scope === "staged") {
    return ["diff", ...common, format, "--cached", ...tail];
  }
  if (hasHead) {
    return ["diff", ...common, format, "HEAD", ...tail];
  }
  return null;
}

function parseNameStatus(output) {
  const tokens = output.split("\0");
  const statuses = new Map();
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1;
    }
    const path = tokens[index++];
    if (path) statuses.set(path, status.slice(0, 1));
  }
  return statuses;
}

function parseNumstat(output) {
  const stats = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    stats.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
      binary: added === "-" || deleted === "-",
    });
  }
  return stats;
}

async function untrackedFiles() {
  const output = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = [];
  for (const record of output.split("\0")) {
    if (!record.startsWith("?? ")) continue;
    const path = record.slice(3);
    let additions = null;
    let binary = false;
    try {
      const info = await stat(`${workspace}/${path}`);
      if (info.isFile() && info.size <= maxDiffBytes) {
        const bytes = await readFile(`${workspace}/${path}`);
        binary = bytes.includes(0);
        if (!binary) {
          const text = bytes.toString("utf8");
          additions = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        }
      } else if (info.isFile()) {
        binary = true;
      }
    } catch {
      // A file may disappear between status and stat. Keep it in the snapshot.
    }
    files.push({
      path,
      status: "?",
      additions,
      deletions: 0,
      binary,
      untracked: true,
    });
  }
  return files;
}

function mergeFiles(target, source) {
  for (const file of source) {
    const previous = target.get(file.path);
    if (!previous) {
      target.set(file.path, file);
      continue;
    }
    target.set(file.path, {
      ...previous,
      ...file,
      additions:
        previous.additions === null || file.additions === null
          ? null
          : previous.additions + file.additions,
      deletions:
        previous.deletions === null || file.deletions === null
          ? null
          : previous.deletions + file.deletions,
      binary: previous.binary || file.binary,
    });
  }
}

async function filesFromCommand(command) {
  const [nameOutput, statOutput] = await Promise.all([
    git(command.map((part) => (part === "--FORMAT--" ? "--name-status" : part)).flatMap((part) => part === "--name-status" ? [part, "-z"] : [part])),
    git(command.map((part) => (part === "--FORMAT--" ? "--numstat" : part)).flatMap((part) => part === "--numstat" ? [part, "-z"] : [part])),
  ]);
  const statuses = parseNameStatus(nameOutput);
  const stats = parseNumstat(statOutput);
  const paths = new Set([...statuses.keys(), ...stats.keys()]);
  return [...paths].map((path) => ({
    path,
    status: statuses.get(path) || "M",
    additions: stats.get(path)?.additions ?? null,
    deletions: stats.get(path)?.deletions ?? null,
    binary: stats.get(path)?.binary ?? false,
    untracked: false,
  }));
}

async function listFiles(scope, context) {
  const files = new Map();
  const command = diffCommand(scope, "--FORMAT--", null, context.hasHead);
  if (command) {
    mergeFiles(files, await filesFromCommand(command));
  } else if (scope === "working") {
    const staged = diffCommand("staged", "--FORMAT--", null, false);
    const unstaged = ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--FORMAT--", "--"];
    mergeFiles(files, await filesFromCommand(staged));
    mergeFiles(files, await filesFromCommand(unstaged));
  }
  if (scope === "working") mergeFiles(files, await untrackedFiles());
  return [...files.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, maxFiles);
}

function summarize(files) {
  return files.reduce(
    (total, file) => {
      total.additions += file.additions || 0;
      total.deletions += file.deletions || 0;
      if (file.binary) total.binary += 1;
      return total;
    },
    { files: files.length, additions: 0, deletions: 0, binary: 0 },
  );
}

async function snapshot(params) {
  const scope = normalizeScope(params?.scope);
  const context = await repositoryContext();
  const files = scope === "commit" && !context.hasHead ? [] : await listFiles(scope, context);
  return {
    workspace,
    repositoryRoot: context.root,
    branch: context.branch,
    head: context.head,
    scope,
    files,
    totals: summarize(files),
    truncated: files.length >= maxFiles,
  };
}

function limitDiff(diff) {
  const bytes = Buffer.from(diff, "utf8");
  if (bytes.length <= maxDiffBytes) return { diff, truncated: false };
  return {
    diff: `${bytes.subarray(0, maxDiffBytes).toString("utf8")}\n\n[Diff truncated at 2 MB]`,
    truncated: true,
  };
}

async function untrackedDiff(path) {
  const info = await stat(`${workspace}/${path}`);
  if (info.size > maxDiffBytes) {
    return {
      diff: [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        `File content is larger than the 2 MB viewer limit: ${path}`,
      ].join("\n"),
      truncated: true,
    };
  }
  const bytes = await readFile(`${workspace}/${path}`);
  if (bytes.includes(0)) {
    return limitDiff(`diff --git a/${path} b/${path}\nnew file mode 100644\nBinary file ${path} added\n`);
  }
  const limited = bytes.subarray(0, maxDiffBytes).toString("utf8");
  const lines = limited.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const diff = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].filter(Boolean).join("\n");
  return { diff, truncated: false };
}

async function fileDiff(params) {
  const scope = normalizeScope(params?.scope);
  const path = typeof params?.path === "string" ? params.path : "";
  if (!path) throw new Error("A file path is required.");
  const context = await repositoryContext();
  const files = await listFiles(scope, context);
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`'${path}' is not part of the selected diff.`);
  if (file.untracked) return { path, scope, ...await untrackedDiff(path) };

  const command = diffCommand(scope, "--patch", path, context.hasHead);
  let diff = "";
  if (command) {
    diff = await git(command);
  } else if (scope === "working") {
    diff = [
      await git(diffCommand("staged", "--patch", path, false)),
      await git(["diff", "--no-ext-diff", "--no-color", "--no-renames", "--patch", "--", path]),
    ].filter(Boolean).join("\n");
  }
  return { path, scope, ...limitDiff(diff) };
}

async function handle(method, params) {
  if (method === "repository.snapshot") return snapshot(params);
  if (method === "repository.fileDiff") return fileDiff(params);
  throw new Error(`Unknown service method '${method}'.`);
}

input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handle(request.method, request.params);
    send({ type: "response", id: request.id, result });
  } catch (error) {
    send({
      type: "response",
      id: request?.id ?? null,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});
