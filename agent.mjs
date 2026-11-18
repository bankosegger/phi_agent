import "dotenv/config";
import OpenAI from "openai";
import chalk from "chalk";
import { rmSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { agentTurn, createMessages } from "./src/agent-core.mjs";
import { previewToolCall } from "./src/preview.mjs";
import { needsConfirmation } from "./src/tools.mjs";

const HELP = `Commands:
  /help   Show this help
  /clear  Start a new conversation
  /exit   Quit (also /quit, or Ctrl+C / Ctrl+D at the prompt)

Press Ctrl+C while the agent is working to cancel the current task.`;

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

let messages = createMessages();
const rl = readline.createInterface({ input, output });

// Ctrl+C cancels the running task, or quits when the agent is idle at the prompt.
// Ctrl+D (end of input) closes readline: open prompts give up, but a running task finishes.
let activeTask = null;
const closed = new AbortController();

rl.on("SIGINT", () => {
  if (activeTask) activeTask.abort();
  else rl.close();
});
rl.on("close", () => closed.abort());

// Returns null if the prompt was cancelled or input has ended.
async function ask(query, signal) {
  const signals = signal ? [closed.signal, signal] : [closed.signal];
  try {
    return await rl.question(query, { signal: AbortSignal.any(signals) });
  } catch (error) {
    if (error.name !== "AbortError") throw error;
    output.write("\n");
    return null;
  }
}

function clearAssets() {
  rmSync(".agent/assets", { recursive: true, force: true });
}

const PREVIEW_STYLES = {
  add: (text) => chalk.green(`  + ${text}`),
  remove: (text) => chalk.red(`  - ${text}`),
  note: (text) => chalk.dim(`    ${text}`),
};

function showToolCall(name, args) {
  const { summary, lines } = previewToolCall(name, args);
  console.log(chalk.dim(`\n[tool] ${name} ${summary}`));
  for (const { kind, text } of lines) console.log(PREVIEW_STYLES[kind](text));
}

async function confirmTool(name, args, signal) {
  if (!needsConfirmation(name)) return true;

  const summary = name === "shell" ? args.cmd : args.path;
  const answer = await ask(chalk.yellow(`[confirm] ${name}: ${summary} [y/N] `), signal);
  return ["y", "yes"].includes(answer?.trim().toLowerCase());
}

async function runTask(task) {
  const controller = new AbortController();
  activeTask = controller;
  let streamed = false;

  try {
    const reply = await agentTurn({
      task,
      openai,
      messages,
      confirmTool,
      signal: controller.signal,
      onToolCall: showToolCall,
      onToken: (token) => {
        streamed = true;
        output.write(token);
      },
    });
    // Replies arrive through onToken, so only print here if nothing was streamed.
    if (streamed) output.write("\n");
    else console.log(reply);
  } catch (error) {
    if (streamed) output.write("\n");
    if (controller.signal.aborted) console.log(chalk.yellow("[cancelled]"));
    else console.log(chalk.red(`[error] ${error.message}`));
  } finally {
    activeTask = null;
  }
}

// Runs a slash command. Returns false when the CLI should quit.
function runCommand(line) {
  const command = line.split(/\s+/)[0].toLowerCase();

  if (command === "/exit" || command === "/quit") return false;

  if (command === "/help") {
    console.log(HELP);
  } else if (command === "/clear") {
    messages = createMessages();
    console.log(chalk.dim("Started a new conversation."));
  } else {
    console.log(chalk.yellow(`Unknown command ${command}. Type /help for commands.`));
  }
  return true;
}

const firstTask = process.argv.slice(2).join(" ");

clearAssets();

console.log(chalk.bold.cyan("Tiny Agent TUI"));
console.log(chalk.dim("Type a task, or /help for commands.\n"));

if (firstTask) {
  await runTask(firstTask);
  console.log();
}

while (true) {
  const line = (await ask(chalk.cyan(": ")))?.trim();
  if (line == null) break;
  if (!line) continue;

  // "/help" is a command; "/src/app.js is broken" is a task.
  if (/^\/[a-z]+(\s|$)/i.test(line)) {
    if (!runCommand(line)) break;
    console.log();
    continue;
  }

  console.log();
  await runTask(line);
  console.log();
}

clearAssets();
rl.close();
