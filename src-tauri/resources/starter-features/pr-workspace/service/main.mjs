import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import readline from "node:readline";

const workspace = process.env.PI_DESKTOP_WORKSPACE || process.cwd();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const maxBuffer = 24 * 1024 * 1024;
const maxPatchBytes = 4 * 1024 * 1024;
let ghExecutable;

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function executableCandidates() {
  return [
    process.env.GH_PATH,
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    `${homedir()}/.local/bin/gh`,
    `${homedir()}/.nix-profile/bin/gh`,
    "gh",
  ].filter(Boolean);
}

function run(executable, args, allowedCodes = [0]) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer,
        timeout: 90_000,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_PAGER: "cat",
          PAGER: "cat",
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && typeof error.code !== "number" && error.code !== "ENOENT") {
          reject(error);
          return;
        }
        if (!allowedCodes.includes(code)) {
          const message = String(stderr || stdout || "").trim();
          reject(new Error(message || `GitHub CLI exited with code ${code}.`));
          return;
        }
        resolve({ code, stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

async function resolveGh() {
  if (ghExecutable) return ghExecutable;
  for (const candidate of executableCandidates()) {
    try {
      if (candidate.includes("/")) await access(candidate);
      await run(candidate, ["--version"]);
      ghExecutable = candidate;
      return candidate;
    } catch {
      // Try the next standard macOS installation path.
    }
  }
  throw new Error("GitHub CLI was not found. Install gh, sign in, then reload PR Workspace.");
}

async function gh(args, allowedCodes = [0]) {
  return run(await resolveGh(), args, allowedCodes);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map((check) => ({
    name: check.name || check.context || check.workflowName || "Check",
    workflow: check.workflowName || null,
    status: String(check.status || check.state || "UNKNOWN").toUpperCase(),
    conclusion: String(check.conclusion || check.state || "").toUpperCase() || null,
    url: check.detailsUrl || check.targetUrl || null,
  }));
}

function checkSummary(checks) {
  const normalized = normalizeChecks(checks);
  const pending = normalized.filter((check) =>
    ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].includes(check.status),
  ).length;
  const failed = normalized.filter((check) =>
    ["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
      check.conclusion || check.status,
    ),
  ).length;
  return {
    total: normalized.length,
    pending,
    failed,
    passed: Math.max(0, normalized.length - pending - failed),
  };
}

function normalizePullRequest(pr) {
  const checks = normalizeChecks(pr.statusCheckRollup);
  return {
    number: pr.number,
    title: pr.title || `Pull request #${pr.number}`,
    url: pr.url,
    state: pr.state || "OPEN",
    isDraft: Boolean(pr.isDraft),
    author: pr.author?.login || pr.author?.name || "unknown",
    updatedAt: pr.updatedAt,
    createdAt: pr.createdAt,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    reviewDecision: pr.reviewDecision || null,
    mergeable: pr.mergeable || null,
    mergeStateStatus: pr.mergeStateStatus || null,
    additions: Number(pr.additions || 0),
    deletions: Number(pr.deletions || 0),
    changedFiles: Number(pr.changedFiles || pr.files?.length || 0),
    body: typeof pr.body === "string" ? pr.body.slice(0, 16_000) : "",
    checks,
    checkSummary: checkSummary(pr.statusCheckRollup),
    files: Array.isArray(pr.files)
      ? pr.files.map((file) => ({
          path: file.path,
          additions: Number(file.additions || 0),
          deletions: Number(file.deletions || 0),
        }))
      : [],
    reviews: Array.isArray(pr.reviews)
      ? pr.reviews.slice(-20).map((review) => ({
          author: review.author?.login || "unknown",
          state: review.state || "COMMENTED",
          submittedAt: review.submittedAt || null,
        }))
      : [],
    comments: Array.isArray(pr.comments) ? pr.comments.length : 0,
    commits: Array.isArray(pr.commits) ? pr.commits.length : 0,
  };
}

async function environmentStatus() {
  let executable;
  try {
    executable = await resolveGh();
  } catch (error) {
    return {
      ghAvailable: false,
      authenticated: false,
      repository: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const auth = await run(executable, ["auth", "status", "--hostname", "github.com"], [0, 1]);
  if (auth.code !== 0) {
    return {
      ghAvailable: true,
      authenticated: false,
      repository: null,
      message: "GitHub CLI is installed but not signed in. Run gh auth login in Terminal.",
    };
  }

  const repo = await run(
    executable,
    ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"],
    [0, 1],
  );
  if (repo.code !== 0) {
    return {
      ghAvailable: true,
      authenticated: true,
      repository: null,
      message: "This workspace is not connected to a GitHub repository that gh can read.",
    };
  }

  const value = parseJson(repo.stdout, "gh repo view");
  return {
    ghAvailable: true,
    authenticated: true,
    executable,
    repository: {
      nameWithOwner: value.nameWithOwner,
      url: value.url,
      defaultBranch: value.defaultBranchRef?.name || null,
    },
    message: null,
  };
}

async function requireReady() {
  const status = await environmentStatus();
  if (!status.ghAvailable || !status.authenticated || !status.repository) {
    throw new Error(status.message || "GitHub CLI is not ready for this workspace.");
  }
  return status;
}

async function listPullRequests(params) {
  const environment = await requireReady();
  const filter = ["review-requested", "mine"].includes(params?.filter)
    ? params.filter
    : "open";
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "60",
    "--json",
    "number,title,url,state,isDraft,author,updatedAt,headRefName,baseRefName,reviewDecision,statusCheckRollup,additions,deletions,changedFiles",
  ];
  if (filter === "review-requested") args.push("--search", "review-requested:@me");
  if (filter === "mine") args.push("--author", "@me");
  const result = await gh(args);
  const values = parseJson(result.stdout, "gh pr list");
  return {
    environment,
    filter,
    pullRequests: Array.isArray(values) ? values.map(normalizePullRequest) : [],
  };
}

async function pullRequestDetail(params) {
  await requireReady();
  const number = Number(params?.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error("A pull request number is required.");
  const result = await gh([
    "pr",
    "view",
    String(number),
    "--json",
    "number,title,body,url,state,isDraft,author,createdAt,updatedAt,headRefName,baseRefName,reviewDecision,mergeable,mergeStateStatus,additions,deletions,changedFiles,files,reviews,comments,statusCheckRollup,commits",
  ]);
  return normalizePullRequest(parseJson(result.stdout, "gh pr view"));
}

function limitPatch(patch) {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= maxPatchBytes) return { patch, truncated: false };
  return {
    patch: `${bytes.subarray(0, maxPatchBytes).toString("utf8")}\n\n[Patch truncated at 4 MB]`,
    truncated: true,
  };
}

function patchForPath(fullPatch, path) {
  const sections = fullPatch.split(/(?=^diff --git )/m);
  const exactHeader = ` b/${path}`;
  const exactTarget = `+++ b/${path}`;
  return sections.find((section) =>
    section.startsWith("diff --git ") &&
    (section.slice(0, section.indexOf("\n")).endsWith(exactHeader) || section.includes(exactTarget)),
  ) || "";
}

async function pullRequestPatch(params) {
  await requireReady();
  const number = Number(params?.number);
  const path = typeof params?.path === "string" ? params.path : "";
  if (!Number.isInteger(number) || number <= 0) throw new Error("A pull request number is required.");
  if (!path) throw new Error("A changed file path is required.");
  const result = await gh(["pr", "diff", String(number), "--patch"]);
  const patch = patchForPath(result.stdout, path);
  if (!patch) throw new Error(`The patch for '${path}' is not available.`);
  return { number, path, ...limitPatch(patch) };
}

async function handle(method, params) {
  if (method === "environment.status") return environmentStatus();
  if (method === "pr.list") return listPullRequests(params);
  if (method === "pr.detail") return pullRequestDetail(params);
  if (method === "pr.patch") return pullRequestPatch(params);
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
