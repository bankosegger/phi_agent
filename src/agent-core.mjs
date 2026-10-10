import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
      description: "Read a text file.",
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
      description: "Write a text file.",
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
];

export function createMessages() {
  return [
    { role: "system", content: "You are a basic coding agent. Use tools to inspect and change files." },
  ];
}

export function needsConfirmation(name) {
  return ["shell", "write_file"].includes(name);
}

export function runTool(name, args) {
  if (name === "shell") {
    return execSync(args.cmd, { encoding: "utf8", stdio: "pipe" });
  }

  if (name === "read_file") {
    return readFileSync(args.path, "utf8");
  }

  if (name === "write_file") {
    const dir = dirname(args.path);
    if (dir !== ".") mkdirSync(dir, { recursive: true });
    writeFileSync(args.path, args.content);
    return "ok";
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
