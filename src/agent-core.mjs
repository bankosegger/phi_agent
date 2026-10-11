import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const ASSET_DIR = ".agent/assets";
const SHELL_TIMEOUT_MS = 30_000;
const MAX_TOOL_OUTPUT = 10_000;

export const tools = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file inside the project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a text file inside a project subfolder. Root-level writes are blocked; use write_asset for generated files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_asset",
      description: "Safely store a generated asset under .agent/assets.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative asset path, like notes/output.txt" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
];

export function createMessages() {
  return [
    {
      role: "system",
      content:
        "You are a basic coding agent. Use tools to inspect and change project files. Store generated files/assets with write_asset unless the user is asking to modify the project source.",
    },
  ];
}

export function needsConfirmation(name) {
  return ["shell", "write_file", "write_asset"].includes(name);
}

export function safeProjectPath(path) {
  if (!path || isAbsolute(path)) throw new Error("Path must be relative");

  const root = process.cwd();
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path must stay inside the project");
  }

  return fullPath;
}

function safeAssetPath(path) {
  const assetRoot = safeProjectPath(ASSET_DIR);
  if (!path || isAbsolute(path)) throw new Error("Asset path must be relative");

  const fullPath = resolve(assetRoot, path);
  const rel = relative(assetRoot, fullPath);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Asset path must stay inside .agent/assets");
  }

  return fullPath;
}

function rejectRootLevelWrite(fullPath) {
  if (dirname(relative(process.cwd(), fullPath)) === ".") {
    throw new Error("Root-level writes are blocked. Use write_asset for generated files, or write inside a project folder like src/.");
  }
}

function truncate(text) {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n[truncated ${text.length - MAX_TOOL_OUTPUT} chars]`;
}

function runShell(cmd) {
  const result = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    timeout: SHELL_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });

  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  if (result.error?.code === "ETIMEDOUT") parts.push(`[timed out after ${SHELL_TIMEOUT_MS / 1000}s]`);
  else if (result.error) parts.push(`[error] ${result.error.message}`);
  else if (result.status !== 0) parts.push(`[exit code ${result.status ?? result.signal}]`);

  return truncate(parts.join("\n") || "(no output)");
}

export function runTool(name, args) {
  if (name === "shell") {
    return runShell(args.cmd);
  }

  if (name === "read_file") {
    return readFileSync(safeProjectPath(args.path), "utf8");
  }

  if (name === "write_file") {
    const path = safeProjectPath(args.path);
    rejectRootLevelWrite(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, args.content);
    return "ok";
  }

  if (name === "write_asset") {
    const path = safeAssetPath(args.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, args.content);
    return `saved to ${ASSET_DIR}/${args.path}`;
  }

  return `Unknown tool: ${name}`;
}

export async function agentTurn({ task, openai, messages, confirmTool, log = console.log }) {
  messages.push({ role: "user", content: task });

  for (let i = 0; i < 10; i++) {
    const response = await openai.chat.completions.create({
      model: process.env.MODEL || "openai/gpt-4o-mini",
      messages,
      tools,
    });

    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls) {
      return message.content ?? "";
    }

    for (const call of message.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        log(`\n[tool] ${call.function.name} ${JSON.stringify(args)}`);

        if (await confirmTool(call.function.name, args)) {
          result = runTool(call.function.name, args);
        } else {
          result = "skipped by user";
        }
      } catch (error) {
        result = `error: ${error.message}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(result),
      });
    }
  }

  return "Stopped after 10 tool rounds.";
}
