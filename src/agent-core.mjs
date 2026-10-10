import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const ASSET_DIR = ".agent/assets";

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

function rejectRootLevelWrite(path) {
  if (!path.includes("/")) {
    throw new Error("Root-level writes are blocked. Use write_asset for generated files, or write inside a project folder like src/.");
  }
}

export function runTool(name, args) {
  if (name === "shell") {
    return execSync(args.cmd, { encoding: "utf8", stdio: "pipe" });
  }

  if (name === "read_file") {
    return readFileSync(safeProjectPath(args.path), "utf8");
  }

  if (name === "write_file") {
    rejectRootLevelWrite(args.path);
    const path = safeProjectPath(args.path);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
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
      const args = JSON.parse(call.function.arguments || "{}");
      log(`\n[tool] ${call.function.name} ${JSON.stringify(args)}`);

      let result;
      try {
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
