import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import readline from "node:readline";

const workspaceInput = resolve(process.env.PI_DESKTOP_WORKSPACE || process.cwd());
const workspace = await realpath(workspaceInput).catch(() => workspaceInput);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const maxFiles = 4_000;
const maxTextBytes = 192 * 1024;
const maxPreviewBytes = 384 * 1024;
const ignoredDirectories = new Set([
  ".git",
  ".dart_tool",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".turbo",
  ".venv",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const languages = new Map([
  [".c", "C"], [".h", "C"], [".cc", "C++"], [".cpp", "C++"], [".cxx", "C++"],
  [".cs", "C#"], [".css", "CSS"], [".dart", "Dart"], [".go", "Go"],
  [".html", "HTML"], [".htm", "HTML"], [".java", "Java"], [".js", "JavaScript"],
  [".jsx", "JavaScript"], [".json", "JSON"], [".kt", "Kotlin"], [".kts", "Kotlin"],
  [".md", "Markdown"], [".mdx", "Markdown"], [".mjs", "JavaScript"], [".cjs", "JavaScript"],
  [".php", "PHP"], [".py", "Python"], [".rb", "Ruby"], [".rs", "Rust"],
  [".scss", "SCSS"], [".sh", "Shell"], [".sql", "SQL"], [".svelte", "Svelte"],
  [".swift", "Swift"], [".toml", "TOML"], [".ts", "TypeScript"], [".tsx", "TypeScript"],
  [".vue", "Vue"], [".xml", "XML"], [".yaml", "YAML"], [".yml", "YAML"],
]);

const filenameLanguages = new Map([
  ["Dockerfile", "Dockerfile"],
  ["Makefile", "Makefile"],
  ["Gemfile", "Ruby"],
]);

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function run(executable, args, allowedCodes = [0]) {
  return new Promise((resolveRun, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && typeof error.code !== "number" && error.code !== "ENOENT") {
          reject(error);
          return;
        }
        if (!allowedCodes.includes(code)) {
          reject(new Error(String(stderr || stdout || `Command exited with code ${code}.`).trim()));
          return;
        }
        resolveRun({ code, stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

function languageFor(path) {
  return filenameLanguages.get(basename(path)) || languages.get(extname(path).toLowerCase()) || "Other";
}

function moduleFor(path) {
  const first = path.split("/")[0];
  return first && first !== path ? first : "(root)";
}

function safePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("A project-relative file path is required.");
  }
  const candidate = resolve(workspace, relativePath);
  if (candidate !== workspace && !candidate.startsWith(`${workspace}${sep}`)) {
    throw new Error("The requested path is outside this workspace.");
  }
  return candidate;
}

function cleanRelativePath(path) {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

async function gitContext() {
  try {
    const rootResult = await run("git", ["rev-parse", "--show-toplevel"]);
    const root = resolve(rootResult.stdout.trim());
    const workspaceFromRoot = cleanRelativePath(relative(root, workspace)) || ".";
    const [branchResult, remoteResult] = await Promise.all([
      run("git", ["branch", "--show-current"], [0, 1]),
      run("git", ["config", "--get", "remote.origin.url"], [0, 1]),
    ]);
    return {
      root,
      workspaceFromRoot,
      branch: branchResult.stdout.trim() || "detached HEAD",
      remote: remoteResult.stdout.trim() || null,
    };
  } catch {
    return null;
  }
}

async function gitFiles(context) {
  const pathspec = context.workspaceFromRoot === "." ? "." : context.workspaceFromRoot;
  const result = await run("git", [
    "-C",
    context.root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    pathspec,
  ]);
  const prefix = context.workspaceFromRoot === "." ? "" : `${context.workspaceFromRoot}/`;
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path)
    .filter((path) => path && path !== context.workspaceFromRoot);
}

async function walk(directory = workspace, prefix = "", results = []) {
  if (results.length >= maxFiles + 1) return results;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (results.length >= maxFiles + 1) break;
    if (entry.isSymbolicLink()) continue;
    const nextRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walk(resolve(directory, entry.name), nextRelative, results);
      }
    } else if (entry.isFile()) {
      results.push(nextRelative);
    }
  }
  return results;
}

async function listProjectFiles(context) {
  let values;
  let source = "filesystem";
  if (context) {
    try {
      values = await gitFiles(context);
      source = "git";
    } catch {
      values = null;
    }
  }
  if (!values) values = await walk();
  const unique = [...new Set(values.map(cleanRelativePath))].sort((a, b) => a.localeCompare(b));
  return {
    paths: unique.slice(0, maxFiles),
    truncated: unique.length > maxFiles,
    source,
  };
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return !sample.includes(0);
}

function lineCount(text, complete) {
  if (!text) return 0;
  const count = (text.match(/\n/g) || []).length + (text.endsWith("\n") ? 0 : 1);
  return complete ? count : null;
}

function relativeImports(path, text, language) {
  const imports = new Set();
  const addMatches = (pattern, group = 1) => {
    for (const match of text.matchAll(pattern)) {
      if (match[group]) imports.add(match[group]);
      if (imports.size >= 30) break;
    }
  };

  if (["JavaScript", "TypeScript", "Vue", "Svelte"].includes(language)) {
    addMatches(/(?:from\s*|import\s*\(|require\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g);
  } else if (language === "Dart") {
    addMatches(/(?:import|export|part)\s+["'](\.{1,2}\/[^"']+)["']/g);
  } else if (language === "Rust") {
    addMatches(/\buse\s+crate::([A-Za-z_][\w]*)/g);
  } else if (language === "Python") {
    addMatches(/^\s*from\s+([.]{1,2}[A-Za-z_][\w.]*)\s+import\s+/gm);
  }

  return [...imports].map((specifier) => {
    if (specifier.startsWith(".")) {
      return cleanRelativePath(relative(workspace, resolve(workspace, dirname(path), specifier)));
    }
    return specifier.replace(/^\.+/, "").replaceAll(".", "/");
  });
}

function targetModule(importPath) {
  if (!importPath || importPath.startsWith("..")) return null;
  return moduleFor(importPath);
}

function entryPointScore(path) {
  const name = basename(path).toLowerCase();
  if (["package.json", "cargo.toml", "pubspec.yaml", "pyproject.toml", "go.mod"].includes(name)) return 100;
  if (/^(main|app|index|server|cli)\.(tsx?|jsx?|mjs|cjs|py|rs|dart|go|swift)$/.test(name)) return 80;
  if (/^(main|lib)\.rs$/.test(name)) return 75;
  if (/^(vite|next|nuxt|svelte|astro)\.config\./.test(name)) return 60;
  return 0;
}

async function inspectFile(path) {
  const absolute = safePath(path);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  const language = languageFor(path);
  let lines = null;
  let imports = [];
  let text = "";
  if (stats.size <= maxTextBytes && language !== "Other") {
    try {
      const buffer = await readFile(absolute);
      if (isProbablyText(buffer)) {
        text = buffer.toString("utf8");
        lines = lineCount(text, true);
        imports = relativeImports(path, text, language);
      }
    } catch {
      // The file can disappear during a live scan; retain its stat metadata.
    }
  }
  return {
    path,
    name: basename(path),
    module: moduleFor(path),
    language,
    size: stats.size,
    lines,
    imports,
    entryPointScore: entryPointScore(path),
  };
}

async function inspectFiles(paths) {
  const records = [];
  const concurrency = 32;
  for (let index = 0; index < paths.length; index += concurrency) {
    const chunk = await Promise.all(paths.slice(index, index + concurrency).map(inspectFile));
    records.push(...chunk.filter(Boolean));
  }
  return records;
}

function summarize(records, context, listing) {
  const languageMap = new Map();
  const moduleMap = new Map();
  const edges = new Map();
  const knownModules = new Set(records.map((file) => file.module));
  let totalBytes = 0;
  let totalLines = 0;
  let countedLineFiles = 0;

  for (const file of records) {
    totalBytes += file.size;
    if (Number.isInteger(file.lines)) {
      totalLines += file.lines;
      countedLineFiles += 1;
    }
    const language = languageMap.get(file.language) || { name: file.language, files: 0, bytes: 0, lines: 0 };
    language.files += 1;
    language.bytes += file.size;
    language.lines += file.lines || 0;
    languageMap.set(file.language, language);

    const module = moduleMap.get(file.module) || {
      name: file.module,
      files: 0,
      bytes: 0,
      lines: 0,
      languages: new Map(),
      entryPoints: [],
    };
    module.files += 1;
    module.bytes += file.size;
    module.lines += file.lines || 0;
    module.languages.set(file.language, (module.languages.get(file.language) || 0) + 1);
    if (file.entryPointScore) module.entryPoints.push(file.path);
    moduleMap.set(file.module, module);

    for (const importPath of file.imports) {
      const target = targetModule(importPath);
      if (!target || target === file.module || !knownModules.has(target)) continue;
      const key = `${file.module}\0${target}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }

  const modules = [...moduleMap.values()].map((module) => ({
    ...module,
    languages: [...module.languages.entries()]
      .map(([name, files]) => ({ name, files }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    entryPoints: module.entryPoints.slice(0, 8),
  })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));

  return {
    workspace: { name: basename(workspace), path: workspace },
    repository: context ? { root: context.root, branch: context.branch, remote: context.remote } : null,
    scan: { source: listing.source, truncated: listing.truncated, limit: maxFiles },
    totals: { files: records.length, bytes: totalBytes, lines: totalLines, countedLineFiles },
    languages: [...languageMap.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    modules,
    edges: [...edges.entries()]
      .map(([key, imports]) => {
        const [from, to] = key.split("\0");
        return { from, to, imports };
      })
      .sort((a, b) => b.imports - a.imports || a.from.localeCompare(b.from)),
    entryPoints: records
      .filter((file) => file.entryPointScore)
      .sort((a, b) => b.entryPointScore - a.entryPointScore || a.path.localeCompare(b.path))
      .slice(0, 24)
      .map((file) => ({ path: file.path, language: file.language, module: file.module })),
    files: records.map(({ imports, entryPointScore, ...file }) => file),
  };
}

async function projectScan() {
  const context = await gitContext();
  const listing = await listProjectFiles(context);
  const records = await inspectFiles(listing.paths);
  return summarize(records, context, listing);
}

async function projectFile(params) {
  const path = typeof params?.path === "string" ? cleanRelativePath(params.path) : "";
  const absolute = safePath(path);
  const stats = await lstat(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("The selected path is not a regular file.");
  const buffer = await readFile(absolute);
  const limited = buffer.subarray(0, maxPreviewBytes);
  if (!isProbablyText(limited)) {
    return { path, language: languageFor(path), size: stats.size, binary: true, truncated: false, content: "" };
  }
  const content = limited.toString("utf8");
  return {
    path,
    language: languageFor(path),
    size: stats.size,
    lines: lineCount(content, buffer.length <= maxPreviewBytes),
    binary: false,
    truncated: buffer.length > maxPreviewBytes,
    imports: relativeImports(path, content, languageFor(path)),
    content,
  };
}

async function handle(method, params) {
  if (method === "project.scan") return projectScan();
  if (method === "project.file") return projectFile(params);
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
