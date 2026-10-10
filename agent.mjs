import "dotenv/config";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

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
];

function needsConfirmation(name) {
  return ["shell", "write_file"].includes(name);
}

async function confirmTool(name, args) {
  if (!needsConfirmation(name)) return true;

  const summary = name === "shell" ? args.cmd : args.path;
  const answer = await rl.question(`[confirm] ${name}: ${summary} [y/N] `);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

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

async function agentTurn(task) {
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
      console.log(`\n[tool] ${call.function.name} ${JSON.stringify(args)}`);

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

const firstTask = process.argv.slice(2).join(" ");
const rl = readline.createInterface({ input, output });

console.log("Tiny Agent TUI");
console.log("Type a task, or /exit to quit.\n");

if (firstTask) {
  console.log(await agentTurn(firstTask));
  console.log();
}

while (true) {
  const task = await rl.question("> ");
  if (!task.trim()) continue;
  if (["/exit", "/quit"].includes(task.trim())) break;

  console.log();
  console.log(await agentTurn(task));
  console.log();
}

rl.close();
