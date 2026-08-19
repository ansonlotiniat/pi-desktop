import { execFile } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = process.env.PI_DESKTOP_WORKSPACE || process.cwd();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function handle(method, params) {
  if (method === "ping") {
    return { ok: true, workspace, echo: params ?? null };
  }
  if (method === "workspace.status") {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: workspace,
      maxBuffer: 1024 * 1024,
    });
    return { text: stdout.trim() };
  }
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

