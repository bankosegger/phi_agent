import "dotenv/config";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});
const task = process.argv.slice(2).join(" ");

if (!task) {
  console.error('Usage: node agent.mjs "your task"');
  process.exit(1);
}

const tools = [
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

const messages = [
  { role: "system", content: "You are a basic coding agent. Use tools to inspect and change files." },
  { role: "user", content: task },
];

function runTool(name, args) {
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

for (let i = 0; i < 10; i++) {
  const response = await openai.chat.completions.create({
    model: process.env.MODEL || "openai/gpt-4o-mini",
    messages,
    tools,
  });

  const message = response.choices[0].message;
  messages.push(message);

  if (!message.tool_calls) {
    console.log(message.content ?? "");
    break;
  }

  for (const call of message.tool_calls) {
    const args = JSON.parse(call.function.arguments || "{}");
    const result = runTool(call.function.name, args);

    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: String(result),
    });
  }
}
