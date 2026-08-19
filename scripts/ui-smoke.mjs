import assert from "node:assert/strict";
import { access, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = process.env.PI_DESKTOP_UI_ARTIFACTS || "/tmp/pi-desktop-ui-smoke";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function locatePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  const cache = join(homedir(), ".npm/_npx");
  const entries = await readdir(cache);
  for (const entry of entries.reverse()) {
    const candidate = join(cache, entry, "node_modules/playwright/index.mjs");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking through npx's local package cache.
    }
  }
  throw new Error("Playwright is not available. Run `npx playwright --version` first.");
}

const { chromium } = await import(pathToFileURL(await locatePlaywright()).href);
await mkdir(artifactDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: chrome });

async function checkedPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return { page, errors };
}

async function smokePrWorkspace() {
  const { page, errors } = await checkedPage();
  await page.addInitScript(() => {
    const summary = { total: 2, pending: 0, failed: 0, passed: 2 };
    const detail = {
      number: 17,
      title: "Add project map",
      url: "https://github.com/pi/desktop/pull/17",
      author: "agent",
      headRefName: "project-map",
      baseRefName: "main",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      additions: 42,
      deletions: 3,
      changedFiles: 2,
      isDraft: false,
      checkSummary: summary,
      files: [
        { path: "src/map.ts", additions: 40, deletions: 2 },
        { path: "README.md", additions: 2, deletions: 1 },
      ],
    };
    window.piDesktop = {
      service: {
        request: async (method, params) => {
          if (method === "pr.list") return {
            environment: { repository: { nameWithOwner: "pi/desktop" } },
            pullRequests: [{ ...detail, updatedAt: "2026-08-13T10:00:00Z" }],
          };
          if (method === "pr.detail") return detail;
          if (method === "pr.patch") return {
            patch: `diff --git a/${params.path} b/${params.path}\n--- a/${params.path}\n+++ b/${params.path}\n@@ -1 +1,2 @@\n-old\n+new\n+mapped`,
          };
          throw new Error(`Unexpected method ${method}`);
        },
      },
      openExternal: async () => undefined,
      navigate: async () => undefined,
      pi: { prompt: async () => undefined },
    };
  });
  await page.goto(pathToFileURL(join(projectRoot, "src-tauri/resources/starter-features/pr-workspace/ui/index.html")).href);
  await page.getByRole("button", { name: /Add project map/ }).click();
  await page.getByText("+mapped", { exact: true }).waitFor();
  assert.equal(await page.locator("#detail-head h1").textContent(), "#17 Add project map");
  assert.equal(await page.locator(".file-row").count(), 2);
  await page.locator("#search").fill("no-match");
  await page.getByText("No pull request matches this filter.").waitFor();
  await page.locator("#search").fill("");
  await page.screenshot({ path: join(artifactDirectory, "pr-workspace.png") });
  assert.deepEqual(errors, []);
  await page.close();
}

async function smokeProjectMap() {
  const { page, errors } = await checkedPage();
  await page.addInitScript(() => {
    const files = [
      { path: "src/index.ts", name: "index.ts", module: "src", language: "TypeScript", size: 110, lines: 5 },
      { path: "src/App.tsx", name: "App.tsx", module: "src", language: "TypeScript", size: 220, lines: 9 },
      { path: "lib/helper.ts", name: "helper.ts", module: "lib", language: "TypeScript", size: 80, lines: 3 },
      { path: "README.md", name: "README.md", module: "(root)", language: "Markdown", size: 60, lines: 4 },
    ];
    const snapshot = {
      workspace: { name: "pi-desktop", path: "/Users/anson/project" },
      repository: { root: "/Users/anson/project", branch: "feature/project-map", remote: null },
      scan: { source: "git", truncated: false, limit: 4000 },
      totals: { files: 4, bytes: 470, lines: 21, countedLineFiles: 4 },
      languages: [
        { name: "TypeScript", files: 3, bytes: 410, lines: 17 },
        { name: "Markdown", files: 1, bytes: 60, lines: 4 },
      ],
      modules: [
        { name: "src", files: 2, bytes: 330, lines: 14, languages: [{ name: "TypeScript", files: 2 }], entryPoints: ["src/index.ts"] },
        { name: "lib", files: 1, bytes: 80, lines: 3, languages: [{ name: "TypeScript", files: 1 }], entryPoints: [] },
        { name: "(root)", files: 1, bytes: 60, lines: 4, languages: [{ name: "Markdown", files: 1 }], entryPoints: [] },
      ],
      edges: [{ from: "src", to: "lib", imports: 1 }],
      entryPoints: [{ path: "src/index.ts", language: "TypeScript", module: "src" }],
      files,
    };
    window.piDesktop = {
      service: {
        request: async (method, params) => {
          if (method === "project.scan") return snapshot;
          if (method === "project.file") return {
            path: params.path,
            language: "TypeScript",
            size: 110,
            lines: 3,
            binary: false,
            truncated: false,
            imports: ["lib/helper"],
            content: 'import { helper } from "../lib/helper";\nconsole.log(helper());\n',
          };
          throw new Error(`Unexpected method ${method}`);
        },
      },
      navigate: async () => undefined,
      pi: { prompt: async () => undefined },
    };
  });
  await page.goto(pathToFileURL(join(projectRoot, "src-tauri/resources/starter-features/project-map/ui/index.html")).href);
  await page.locator('[data-map-module="src"]').click();
  assert.equal(await page.locator("#inspector-head h1").textContent(), "src");
  await page.locator('[data-path="src/index.ts"]').click();
  await page.getByText("console.log(helper());", { exact: true }).waitFor();
  assert.equal(await page.locator("#metric-files").textContent(), "4");
  await page.locator("#search").fill("helper");
  await page.locator('[data-path="lib/helper.ts"]').waitFor();
  await page.locator("#search").fill("");
  await page.screenshot({ path: join(artifactDirectory, "project-map.png") });
  assert.deepEqual(errors, []);
  await page.close();
}

async function smokePermissionPreview() {
  const previewUrl = process.env.PI_DESKTOP_PREVIEW_URL;
  if (!previewUrl) return;
  const { page, errors } = await checkedPage();
  await page.goto(`${previewUrl}?preview=permission`);
  await page.getByText("Pi wants to run a command", { exact: true }).waitFor();
  assert.equal(await page.locator(".tool-access-select select").inputValue(), "ask");
  assert.equal(await page.getByRole("button", { name: "Allow once" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Deny" }).count(), 1);
  await page.screenshot({ path: join(artifactDirectory, "permission-request.png") });
  assert.deepEqual(errors, []);
  await page.close();
}

try {
  await smokePrWorkspace();
  await smokeProjectMap();
  await smokePermissionPreview();
  process.stdout.write(`Headless UI smoke tests passed. Screenshots: ${artifactDirectory}\n`);
} finally {
  await browser.close();
}
