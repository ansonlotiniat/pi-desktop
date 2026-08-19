import readline from "node:readline";

const workspace = process.env.PI_DESKTOP_WORKSPACE || process.cwd();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function handle(method, params) {
  if (method === "feature.load") return { workspace, params: params ?? null };
  throw new Error(`Unknown service method '${method}'.`);
}

input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    send({ type: "response", id: request.id, result: await handle(request.method, request.params) });
  } catch (error) {
    send({
      type: "response",
      id: request?.id ?? null,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});
