// A small MCP server for mcp.test.mjs: JSON-RPC messages, a line each, on stdin and stdout.
// With "--silent", it never answers, to test timeouts.
import { createInterface } from "node:readline";

const silent = process.argv.includes("--silent");
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const text = (id, value) => send({ id, result: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] } });

const firstPage = [
  { name: "echo", description: "Says the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
];
const secondPage = ["fail", "image", "slow", "ask", "change", "crash", "cancelled", "argv"].map((name) => ({ name, description: `The ${name} tool` }));
let changed = false;
const cancelled = [];
const answers = new Map(); // the client's answers to this server's requests, by id
let nextId = 1000;

// A request to the client; resolves to its answer.
function ask(method) {
  return new Promise((resolve) => {
    const id = nextId++;
    answers.set(id, resolve);
    send({ id, method });
  });
}

process.stderr.write("fake server starting\n");
process.stdout.write("a log line that isn't a message\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (silent) return;
  const message = JSON.parse(line);
  if (message.id != null && !message.method) return answers.get(message.id)?.(message);
  const { id, method, params } = message;
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1.0.0" } } });
  }
  if (method === "notifications/cancelled") return cancelled.push(params.requestId);
  if (method === "tools/list") {
    if (!params?.cursor) return send({ id, result: { tools: firstPage, nextCursor: "page-2" } });
    return send({ id, result: { tools: changed ? [...secondPage, { name: "added", description: "New" }] : secondPage } });
  }
  if (method !== "tools/call") return;

  const { name, arguments: args } = params;
  if (name === "echo") return text(id, args.text);
  if (name === "add") return send({ id, result: { content: [], structuredContent: { sum: args.a + args.b } } });
  if (name === "fail") return send({ id, result: { isError: true, content: [{ type: "text", text: "it broke" }] } });
  if (name === "image") {
    return send({ id, result: { content: [{ type: "text", text: "a dot:" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] } });
  }
  if (name === "slow") return; // never answers: to be cancelled
  if (name === "ask") {
    const ping = await ask("ping");
    const roots = await ask("roots/list");
    const sampling = await ask("sampling/createMessage");
    return text(id, { ping: ping.result, roots: roots.result.roots, sampling: sampling.error.code });
  }
  if (name === "change") {
    changed = true;
    send({ method: "notifications/tools/list_changed" });
    return text(id, "changed");
  }
  if (name === "crash") {
    process.stderr.write("fatal: out of cheese\n");
    process.exit(3);
  }
  if (name === "cancelled") return text(id, cancelled);
  if (name === "argv") return text(id, process.argv.slice(2));
  send({ id, error: { code: -32602, message: `there's no tool ${name}` } });
});
