import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ASSET_DIR = ".agent/assets";
const SHELL_TIMEOUT_MS = 30_000;
const MAX_TOOL_OUTPUT = 10_000;
const MAX_LIST_ENTRIES = 500;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".agent"]);

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
      description: "Read a text file inside the project. Optionally read only a 1-indexed, inclusive line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a project directory. Folders end with /. Skips node_modules, .git and .agent.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list. Defaults to the project root." },
          recursive: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search project files for a regular expression. Returns path:line:text matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression" },
          path: { type: "string", description: "File or directory to search. Defaults to the project root." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact occurrence of old_string with new_string in a file. Fails if old_string is missing or appears more than once, so include enough context to make it unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_file",
      description: "Append text to a file inside a project subfolder, creating it if needed.",
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
  return ["shell", "write_file", "write_asset", "edit_file", "append_file"].includes(name);
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

function readLines(text, start, end) {
  const lines = text.split("\n");
  const from = Math.max(1, start ?? 1);
  const to = Math.min(lines.length, end ?? lines.length);
  if (from > to) throw new Error(`Line range ${from}-${to} is outside the file (${lines.length} lines)`);
  return lines.slice(from - 1, to).join("\n");
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (visit(fullPath, entry.isDirectory()) === false) return false;
    if (entry.isDirectory() && walk(fullPath, visit) === false) return false;
  }
}

function listDir(path = ".", recursive = false) {
  const root = safeProjectPath(path);
  const entries = [];

  if (recursive) {
    walk(root, (fullPath, isDir) => {
      if (entries.length >= MAX_LIST_ENTRIES) return false;
      entries.push(relative(root, fullPath).replaceAll("\\", "/") + (isDir ? "/" : ""));
    });
  } else {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
      entries.push(entry.name + (entry.isDirectory() ? "/" : ""));
    }
  }

  const suffix = entries.length >= MAX_LIST_ENTRIES ? `\n[stopped at ${MAX_LIST_ENTRIES} entries]` : "";
  return (entries.sort().join("\n") || "(empty)") + suffix;
}

function grep(pattern, path = ".") {
  const regex = new RegExp(pattern);
  const root = safeProjectPath(path);
  const matches = [];

  const searchFile = (fullPath) => {
    if (statSync(fullPath).size > MAX_GREP_FILE_BYTES) return;
    const text = readFileSync(fullPath, "utf8");
    if (text.includes("\0")) return;

    const shown = relative(process.cwd(), fullPath).replaceAll("\\", "/");
    for (const [i, line] of text.split("\n").entries()) {
      if (!regex.test(line)) continue;
      matches.push(`${shown}:${i + 1}:${line.trimEnd().slice(0, 300)}`);
      if (matches.length >= MAX_GREP_MATCHES) return false;
    }
  };

  if (statSync(root).isDirectory()) {
    walk(root, (fullPath, isDir) => (isDir ? undefined : searchFile(fullPath)));
  } else {
    searchFile(root);
  }

  const suffix = matches.length >= MAX_GREP_MATCHES ? `\n[stopped at ${MAX_GREP_MATCHES} matches]` : "";
  return (matches.join("\n") || "no matches") + suffix;
}

export function runTool(name, args) {
  if (name === "shell") {
    return runShell(args.cmd);
  }

  if (name === "read_file") {
    const text = readFileSync(safeProjectPath(args.path), "utf8");
    const hasRange = args.start_line != null || args.end_line != null;
    return truncate(hasRange ? readLines(text, args.start_line, args.end_line) : text);
  }

  if (name === "list_dir") {
    return listDir(args.path, args.recursive);
  }

  if (name === "grep") {
    return grep(args.pattern, args.path);
  }

  if (name === "edit_file") {
    const path = safeProjectPath(args.path);
    rejectRootLevelWrite(path);
    if (!args.old_string) throw new Error("old_string must not be empty");

    const text = readFileSync(path, "utf8");
    const count = text.split(args.old_string).length - 1;
    if (count === 0) throw new Error("old_string not found");
    if (count > 1) throw new Error(`old_string appears ${count} times; add more context to make it unique`);

    // A replacer function avoids special "$" patterns in new_string.
    writeFileSync(path, text.replace(args.old_string, () => args.new_string));
    return "ok";
  }

  if (name === "append_file") {
    const path = safeProjectPath(args.path);
    rejectRootLevelWrite(path);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, args.content);
    return "ok";
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

async function collectStream(stream, onToken) {
  let content = "";
  const toolCalls = [];

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      onToken?.(delta.content);
    }

    for (const part of delta.tool_calls ?? []) {
      const call = (toolCalls[part.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  }

  const message = { role: "assistant", content: content || null };
  const calls = toolCalls.filter(Boolean);
  if (calls.length) message.tool_calls = calls;
  return message;
}

export async function agentTurn({ task, openai, messages, confirmTool, log = console.log, onToken }) {
  messages.push({ role: "user", content: task });

  for (let i = 0; i < 10; i++) {
    const stream = await openai.chat.completions.create({
      model: process.env.MODEL || "openai/gpt-4o-mini",
      messages,
      tools,
      stream: true,
    });

    const message = await collectStream(stream, onToken);
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

  const stopped = "Stopped after 10 tool rounds.";
  onToken?.(stopped);
  return stopped;
}
