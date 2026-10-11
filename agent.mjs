import "dotenv/config";
import OpenAI from "openai";
import chalk from "chalk";
import { rmSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { agentTurn, createMessages, needsConfirmation } from "./src/agent-core.mjs";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const messages = createMessages();
const rl = readline.createInterface({ input, output });

function clearAssets() {
  rmSync(".agent/assets", { recursive: true, force: true });
}

async function confirmTool(name, args) {
  if (!needsConfirmation(name)) return true;

  const summary = name === "shell" ? args.cmd : args.path;
  const answer = await rl.question(chalk.yellow(`[confirm] ${name}: ${summary} [y/N] `));
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

async function runTask(task) {
  try {
    return await agentTurn({
      task,
      openai,
      messages,
      confirmTool,
      log: (message) => console.log(chalk.dim(message)),
    });
  } catch (error) {
    return chalk.red(`[error] ${error.message}`);
  }
}

const firstTask = process.argv.slice(2).join(" ");

clearAssets();

console.log(chalk.bold.cyan("Tiny Agent TUI"));
console.log(chalk.dim("Type a task, or /exit to quit.\n"));

if (firstTask) {
  console.log(await runTask(firstTask));
  console.log();
}

while (true) {
  const task = await rl.question(chalk.cyan(": "));
  if (!task.trim()) continue;
  if (["/exit", "/quit"].includes(task.trim())) break;

  console.log();
  console.log(await runTask(task));
  console.log();
}

clearAssets();
rl.close();
