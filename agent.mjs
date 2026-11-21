#!/usr/bin/env node
import dotenv from "dotenv";
import OpenAI from "openai";
import chalk from "chalk";
import { dirname, join } from "node:path";
import { stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, INSTRUCTIONS_FILE, agentTurn, compactMessages, createMessages, readProjectInstructions } from "./src/agent-core.mjs";
import { FileChanges } from "./src/changes.mjs";
import { ContextWindow, contextLengthOf, fetchContextLengths, isOverflowError } from "./src/context.mjs";
import { createInput } from "./src/input.mjs";
import { previewToolCall, previewToolResult } from "./src/preview.mjs";
import { runInSandbox } from "./src/sandbox.mjs";
import { createStatus } from "./src/status.mjs";
import { needsConfirmation } from "./src/tools.mjs";

// Settings come from the .env next to this file, not the current directory, so the agent
// can be started from any project folder.
const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(AGENT_DIR, ".env");
dotenv.config({ path: ENV_FILE, quiet: true });

if (!process.env.OPENROUTER_API_KEY) {
  console.error(chalk.red(`OPENROUTER_API_KEY is not set. Add it to ${ENV_FILE} or to your environment.`));
  process.exit(1);
}

// With --sandbox (or SANDBOX=docker in .env), this process only starts the agent in a Docker
// container, attached to this terminal, and exits with its exit code.
const IN_SANDBOX = process.env.PHI_AGENT_SANDBOX === "1";
const cliArgs = process.argv.slice(2);
const taskArgs = cliArgs.filter((arg) => arg !== "--sandbox");
// `npm run agent --sandbox`, without the "--", leaves the flag to npm, which passes it on as
// npm_config_sandbox. Honor it rather than run outside the sandbox the user asked for.
const sandboxRequested = cliArgs.includes("--sandbox") || process.env.SANDBOX === "docker" || process.env.npm_config_sandbox === "true";
if (!IN_SANDBOX && sandboxRequested) {
  process.exit(
    await runInSandbox({
      agentDir: AGENT_DIR,
      agentArgs: taskArgs,
      info: (text) => console.error(chalk.dim(text)),
      warn: (text) => console.error(chalk.red(text)),
    }),
  );
}

const HELP = `Commands:
  /help          Show this help
  /clear         Start a new conversation
  /compact       Summarize the conversation so far, to free up the model's context
  /undo          Revert the file changes of the last task (again for the task before)
  /model [name]  Show the model, or switch to another OpenRouter model
  /exit          Quit (also /quit, or Ctrl+C / Ctrl+D at the prompt)

Press Ctrl+C while the agent is working to cancel the current task. Messages you
enter while it works run after it. Pasted lines are sent together as one message.
When asked to confirm a tool, answer y (yes), n (no), or a (always: run that tool
without asking until you quit).`;

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

let model = process.env.MODEL || DEFAULT_MODEL;
let messages;
const context = new ContextWindow();
let contextLengths = null; // each model's context window, once OpenRouter's model list is in

// Starts a conversation with the project's AGENTS.md, read afresh. Returns whether there is one.
function newConversation() {
  const instructions = readProjectInstructions();
  messages = createMessages({ instructions, sandbox: IN_SANDBOX });
  context.reset();
  return instructions != null;
}

// The model list loads in the background. Until it has (or if it can't), the context window
// is assumed to be 128k tokens and the usage line shows the context in tokens, not percent.
fetchContextLengths(openai).then(
  (lengths) => {
    contextLengths = lengths;
    context.limit = contextLengthOf(lengths, model);
  },
  () => {},
);

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// "a, b, c and 4 more"
function nameList(names, max = 5) {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

function formatTokens(count) {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

// Ctrl+C cancels the running task (and drops messages entered for after it), or quits when
// the agent is idle at the prompt. Ctrl+D (end of input) closes the input: open prompts give
// up, but a running task finishes.
let activeTask = null;
const userInput = createInput({
  onQueued: () => print(chalk.dim("  (queued: runs after the current task)")),
});

userInput.onInterrupt(() => {
  if (!activeTask) return userInput.close();
  activeTask.abort();
  const dropped = userInput.clearQueue();
  if (dropped) print(chalk.dim(`  (dropped ${plural(dropped, "queued message")})`));
});

// A spinner shows what the agent is waiting on. It steps aside while the user types ahead.
const status = createStatus({ paused: () => userInput.typing });
userInput.beforeKeypress(() => status.erase());

// Whether the cursor is after streamed reply text rather than at the start of a line.
let lineOpen = false;

function endLine() {
  if (!lineOpen) return;
  output.write("\n");
  lineOpen = false;
}

// Prints a line of output, on its own line, in place of the spinner (which comes back after).
function print(text = "") {
  status.erase();
  endLine();
  console.log(text);
}

function writeToken(token, style = (text) => text) {
  status.stop();
  output.write(style(token));
  lineOpen = !token.endsWith("\n");
}

const WRITING = { write_file: "Writing", write_asset: "Writing", append_file: "Appending to", edit_file: "Editing" };

function activityText(activity) {
  if (activity.type === "waiting") return "Thinking";
  if (activity.type === "compacting") return "Summarizing the conversation to free up context";
  if (activity.type === "running") return activity.name === "shell" ? "Running the command" : `Running ${activity.name}`;
  // A tool call streaming in, like the content of a file the model is writing.
  let doing = activity.name === "shell" ? "Preparing a command" : `Preparing ${activity.name}`;
  if (activity.path && WRITING[activity.name]) doing = `${WRITING[activity.name]} ${activity.path}`;
  return activity.chars >= 1000 ? `${doing} · ${formatTokens(activity.chars)} characters` : doing;
}

function showActivity(activity) {
  if (!status.enabled) return;
  endLine(); // the spinner needs a line of its own
  status.set(activityText(activity));
}

const PREVIEW_STYLES = {
  add: (text) => chalk.green(`  + ${text}`),
  remove: (text) => chalk.red(`  - ${text}`),
  same: (text) => chalk.dim(`    ${text}`),
  note: (text) => chalk.dim(`    ${text}`),
  output: (text) => chalk.dim(`  │ ${text}`),
  error: (text) => chalk.red(`  ✗ ${text}`),
};

function showLines(lines) {
  for (const { kind, text } of lines) print(PREVIEW_STYLES[kind](text));
}

function showToolCall(name, args) {
  status.stop();
  const { summary, lines } = previewToolCall(name, args);
  print(chalk.dim(`\n[tool] ${name} ${summary}`.trimEnd()));
  showLines(lines);
}

function showToolResult(name, result) {
  status.stop();
  showLines(previewToolResult(name, result));
}

const CONTEXT_CHANGES = {
  trimmed: () => chalk.dim("  (removed old tool output to make room in the model's context)"),
  compacted: () => chalk.dim("  (summarized the earlier conversation to make room in the model's context)"),
  compactFailed: ({ error }) => chalk.yellow(`  (couldn't summarize the earlier conversation: ${error.message})`),
};

function showContextChange(change) {
  status.stop();
  print(CONTEXT_CHANGES[change.type](change));
}

// Tools the user answered "always" for; they run without asking until the CLI exits.
const alwaysAllowed = new Set();

async function confirmTool(name, args, signal) {
  if (!needsConfirmation(name) || alwaysAllowed.has(name)) return true;

  const summary = name === "shell" ? args.cmd : args.path;
  const answer = (await userInput.ask(chalk.yellow(`[confirm] ${name}: ${summary} [y/N/a=always] `), signal))?.trim().toLowerCase();

  if (answer === "a" || answer === "always") {
    alwaysAllowed.add(name);
    print(chalk.dim(`    ${name} will run without asking until you quit.`));
    return true;
  }
  return answer === "y" || answer === "yes";
}

// The file changes of each task that changed files, newest last, for /undo.
const undoStack = [];
let sessionCost = 0;

function formatCost(dollars) {
  return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`;
}

function newUsage() {
  return { requests: 0, input: 0, output: 0, cost: null };
}

function addUsage(total, usage) {
  total.requests++;
  total.input += usage.prompt_tokens ?? 0;
  total.output += usage.completion_tokens ?? 0;
  // OpenRouter reports what the request cost; other providers may not.
  if (typeof usage.cost === "number") total.cost = (total.cost ?? 0) + usage.cost;
}

// "12.3k tokens in · 456 out · $0.0021 (session $0.0300) · context 9% of 128k"
function usageSummary({ input, output: out, cost }) {
  const parts = [`${formatTokens(input)} tokens in`, `${formatTokens(out)} out`];
  if (cost != null) parts.push(sessionCost > cost ? `${formatCost(cost)} (session ${formatCost(sessionCost)})` : formatCost(cost));
  if (context.used != null) {
    parts.push(
      context.limit
        ? `context ${Math.round((100 * context.used) / context.limit)}% of ${formatTokens(context.limit)}`
        : `context ${formatTokens(context.used)} tokens`,
    );
  }
  return parts.join(" · ");
}

// After a task or /compact: what it cost, and how full the model's context is.
function showUsage(usage) {
  sessionCost += usage.cost ?? 0;
  if (usage.requests) print(chalk.dim(usageSummary(usage)));
}

function showError(error, signal) {
  if (signal.aborted) return print(chalk.yellow("[cancelled]"));
  print(chalk.red(`[error] ${error.message}`));
  if (isOverflowError(error)) print(chalk.dim("The conversation is too long for this model. /compact summarizes it; /clear starts over."));
}

async function runTask(task) {
  const controller = new AbortController();
  const changes = new FileChanges();
  const usage = newUsage();
  const saved = [];
  activeTask = controller;
  let streamed = false;

  try {
    const reply = await agentTurn({
      task,
      openai,
      messages,
      model,
      changes,
      context,
      confirmTool,
      signal: controller.signal,
      onToolCall: showToolCall,
      onToolResult: (name, result) => {
        if (name === "write_asset" && result.status === "ok") saved.push(result.content.replace(/^saved to /, ""));
        showToolResult(name, result);
      },
      onUsage: (requestUsage) => addUsage(usage, requestUsage),
      onToken: (token) => {
        streamed = true;
        writeToken(token);
      },
      onActivity: showActivity,
      onContextChange: showContextChange,
    });
    // Replies arrive through onToken, so only print here if nothing was streamed.
    if (!streamed && reply) print(reply);
  } catch (error) {
    status.stop();
    showError(error, controller.signal);
  } finally {
    activeTask = null;
    status.stop();
    endLine();
  }

  const changed = changes.paths;
  if (changed.length) {
    undoStack.push(changes);
    print(chalk.dim(`Changed ${nameList(changed)} · /undo to revert`));
  }
  if (saved.length) print(chalk.dim(`Saved ${nameList(saved)}`));
  showUsage(usage);
}

const UNDO_RESULTS = {
  restored: (path) => `  restored ${path}`,
  deleted: (path) => `  deleted ${path} (the agent created it)`,
  kept: (path) => chalk.yellow(`  kept ${path}: it changed again after the agent wrote it`),
};

function undo() {
  const changes = undoStack.pop();
  if (!changes) {
    print(chalk.dim("Nothing to undo."));
    return;
  }

  const results = changes.undo();
  for (const { path, action } of results) print(UNDO_RESULTS[action](path));

  // Tell the model, which would otherwise assume its changes are still there.
  const reverted = results.filter(({ action }) => action !== "kept").map(({ path }) => path);
  if (reverted.length) {
    messages.push({
      role: "user",
      content: `(I undid your changes to ${reverted.join(", ")}. Those files are back to how they were before you changed them.)`,
    });
  }
}

// Replaces the conversation so far with a summary the model writes, which is shown as it comes.
async function compact() {
  if (messages.length < 3) {
    print(chalk.dim("Nothing to compact yet."));
    return;
  }

  const controller = new AbortController();
  const usage = newUsage();
  const before = context.estimate(messages);
  activeTask = controller;
  showActivity({ type: "compacting" });
  try {
    await compactMessages({
      openai,
      model,
      messages,
      context,
      signal: controller.signal,
      onUsage: (requestUsage) => addUsage(usage, requestUsage),
      onToken: (token) => writeToken(token, chalk.dim),
    });
    endLine();
    context.reset();
    print(chalk.dim(`\nCompacted the conversation from about ${formatTokens(before)} tokens to ${formatTokens(context.estimate(messages))}.`));
  } catch (error) {
    status.stop();
    showError(error, controller.signal);
  } finally {
    activeTask = null;
    status.stop();
    endLine();
  }
  showUsage(usage);
}

function showModel() {
  const size = context.limit ? chalk.dim(` · ${formatTokens(context.limit)} tokens of context`) : "";
  print(`${model}${size}\n${chalk.dim("Switch with /model <name>, using a model ID from openrouter.ai/models.")}`);
}

function switchModel(name) {
  model = name;
  context.limit = contextLengthOf(contextLengths, model);
  print(chalk.dim(`Using ${model} from the next task on.`));
  if (contextLengths && !context.limit) {
    print(chalk.yellow(`${model} isn't in OpenRouter's model list; check the name at openrouter.ai/models.`));
  }
}

// Runs a slash command. Resolves to false when the CLI should quit.
async function runCommand(line) {
  const command = line.split(/\s+/)[0].toLowerCase();
  const argument = line.slice(command.length).trim();

  if (command === "/exit" || command === "/quit") return false;

  if (command === "/help") {
    print(HELP);
  } else if (command === "/clear") {
    const withInstructions = newConversation();
    print(chalk.dim(`Started a new conversation${withInstructions ? ` (with ${INSTRUCTIONS_FILE})` : ""}.`));
  } else if (command === "/compact") {
    await compact();
  } else if (command === "/undo") {
    undo();
  } else if (command === "/model" && argument) {
    switchModel(argument);
  } else if (command === "/model") {
    showModel();
  } else {
    print(chalk.yellow(`Unknown command ${command}. Type /help for commands.`));
  }
  return true;
}

const firstTask = taskArgs.join(" ");
const hasInstructions = newConversation();
// In the sandbox, the project is at /workspace; show the folder it is on the host.
const projectDir = IN_SANDBOX ? process.env.PHI_AGENT_HOST_PROJECT || process.cwd() : process.cwd();

print(chalk.bold.cyan("Tiny Agent TUI"));
print(
  chalk.dim(
    [model, projectDir, IN_SANDBOX && "in a Docker sandbox", hasInstructions && `following ${INSTRUCTIONS_FILE}`].filter(Boolean).join(" · "),
  ),
);
print(chalk.dim("Type a task, or /help for commands.\n"));

if (firstTask) {
  await runTask(firstTask);
  print();
}

while (true) {
  const text = await userInput.next(chalk.cyan(": "));
  if (text == null) break;
  const line = text.trim();
  if (!line) continue;

  // "/help" is a command; "/src/app.js is broken" is a task.
  if (/^\/[a-z]+(\s|$)/i.test(line)) {
    try {
      if (!(await runCommand(line.split("\n")[0]))) break;
    } catch (error) {
      print(chalk.red(`[error] ${error.message}`));
    }
    print();
    continue;
  }

  print();
  await runTask(line);
  print();
}

userInput.close();
