#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL,
  INSTRUCTIONS_FILE,
  USER_DIR,
  agentTurn,
  compactMessages,
  createMessages,
  readProjectInstructions,
  readUserInstructions,
} from "./src/agent-core.mjs";
import { FileChanges } from "./src/changes.mjs";
import { DEFAULT_CLAUDE_MODEL, EFFORTS, dropThinking, fetchClaudeModels, isClaudeModel } from "./src/claude.mjs";
import { USAGE, parseArgs } from "./src/cli-args.mjs";
import { commandPath, commandTask, findCommand, isCommandLine, loadCommands, nearCommand } from "./src/commands.mjs";
import { ContextWindow, fetchModels, isOverflowError, modelInfo } from "./src/context.mjs";
import { imagePart, imagePathsIn } from "./src/images.mjs";
import { mentionParts } from "./src/mentions.mjs";
import { createMarkdownWriter } from "./src/markdown.mjs";
import { completeLine } from "./src/complete.mjs";
import { createInput } from "./src/input.mjs";
import { previewToolCall, previewToolResult } from "./src/preview.mjs";
import { backgroundProcesses } from "./src/processes.mjs";
import { PERMISSIONS_FILE, allows, loadRules, ruleFor, saveRules } from "./src/permissions.mjs";
import { runInSandbox } from "./src/sandbox.mjs";
import { deleteSession, listSessions, loadHistory, loadSession, newSessionFile, saveHistory, saveSession, searchSessions } from "./src/sessions.mjs";
import { createStatus } from "./src/status.mjs";
import { displayWidth, glyphs, hasColors, theme, truncateEnd } from "./src/theme.mjs";
import { needsConfirmation } from "./src/tools.mjs";
import {
  banner,
  commandLines,
  confirmPrompt,
  detailLines,
  excerpt,
  formatDuration,
  formatTokens,
  helpLines,
  lineWidth,
  markdownAsText,
  nameList,
  numberedLines,
  outcomeLine,
  plural,
  questionLine,
  taskFooter,
  toolCallLine,
} from "./src/ui.mjs";

// Settings come from the .env next to this file, not the current directory, so the agent
// can be started from any project folder.
const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(AGENT_DIR, ".env");
dotenv.config({ path: ENV_FILE, quiet: true });

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(AGENT_DIR, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
})();

const cliArgs = process.argv.slice(2);
let options;
let firstTask;
try {
  ({ options, task: firstTask } = parseArgs(cliArgs));
} catch (error) {
  console.error(theme.danger(`${error.message}\nRun with --help for the options.`));
  process.exit(2);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (options.version) {
  console.log(VERSION ?? "unknown");
  process.exit(0);
}

// With --print, the agent runs one task without reading the terminal: the reply goes to stdout,
// and everything else (tool calls, errors, usage) to stderr, so a script gets just the reply.
// (Starting the sandbox needs to know too, before anything else is set up.)
const HEADLESS = options.print || options.json; // --json implies --print

// OpenRouter's key is for the models it has, like openai/gpt-4o-mini; Anthropic's for Claude
// models through the Claude API, like claude-opus-5-5. Either will do, or both.
if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    theme.danger(
      `Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set. Add one to ${ENV_FILE} or to your environment: OpenRouter's for its models, Anthropic's for Claude models through the Claude API.`,
    ),
  );
  process.exit(1);
}

const openai = process.env.OPENROUTER_API_KEY ? new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY }) : null;
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// Why a model can't be used, for want of its API key, or null.
function keyProblem(name) {
  if (isClaudeModel(name) && !claude) {
    return `${name} is a Claude API model: it needs ANTHROPIC_API_KEY in .env. Through OpenRouter, Claude models start with anthropic/.`;
  }
  if (!isClaudeModel(name) && !openai) {
    return `${name} is an OpenRouter model: it needs OPENROUTER_API_KEY in .env. Claude API models start with claude-, like ${DEFAULT_CLAUDE_MODEL}.`;
  }
  return null;
}

let model = options.model || process.env.MODEL || (openai ? DEFAULT_MODEL : DEFAULT_CLAUDE_MODEL);
if (keyProblem(model)) {
  console.error(theme.danger(keyProblem(model)));
  process.exit(1);
}

// With --sandbox (or SANDBOX=docker in .env), this process only starts the agent in a Docker
// container, attached to this terminal, and exits with its exit code.
const IN_SANDBOX = process.env.PHI_AGENT_SANDBOX === "1";
// `npm run agent --sandbox`, without the "--", leaves the flag to npm, which passes it on as
// npm_config_sandbox. Honor it rather than run outside the sandbox the user asked for.
const sandboxRequested = options.sandbox || process.env.SANDBOX === "docker" || process.env.npm_config_sandbox === "true";
if (!IN_SANDBOX && sandboxRequested) {
  process.exit(
    await runInSandbox({
      agentDir: AGENT_DIR,
      agentArgs: cliArgs.filter((arg) => arg !== "--sandbox"),
      // --print only reads input that is piped in. Attaching a terminal would leave the agent
      // in the container waiting for input that the user never types.
      attachInput: !HEADLESS || !process.stdin.isTTY,
      info: (text) => console.error(theme.muted(text)),
      warn: (text) => console.error(theme.danger(text)),
    }),
  );
}

// EFFORT in .env: how much Claude models think through the Claude API, from low to max. Unset,
// each model thinks as much as it does by default.
const effort = EFFORTS.find((level) => level === process.env.EFFORT?.trim().toLowerCase()) ?? null;
if (process.env.EFFORT?.trim() && !effort) {
  console.error(theme.warning(`${glyphs.warn} EFFORT=${process.env.EFFORT} isn't a level Claude knows (${EFFORTS.join(", ")}), so each model uses its default.`));
}

// For Tab completion.
const COMMANDS = ["/help", "/clear", "/resume", "/compact", "/undo", "/plan", "/model", "/processes", "/stop", "/permissions", "/exit", "/quit"];

// The user's own slash commands (see commands.mjs), read afresh each time, so a command file
// that was added or changed works at once.
function customCommands() {
  return loadCommands({ builtIn: COMMANDS }).commands;
}

// Plan mode (/plan, or --plan): tasks only look around and end in a plan.
let planMode = options.plan;

// Background processes the model started end with the agent, however it ends. (Quitting
// normally stops them before this.) On POSIX they have their own process group, so closing
// the terminal wouldn't stop them otherwise.
process.on("exit", () => backgroundProcesses.killAll());
for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  process.on(signal, () => process.exit(code));
}

let messages;
const context = new ContextWindow();
// What the model lists say about each model (OpenRouter's, and the Claude API's), once one is
// in, and which of the two are: "openrouter", "claude".
let models = null;
const listed = new Set();

// Requests of a conversation through OpenRouter go to the provider that has its prompt cached.
let sessionId = randomUUID();

// The conversation's saved file and what the list of saved conversations shows about it:
// { file, created, title, lastTask, tasks }. Null until it is first saved.
let session = null;
let saveFailed = false;

// Starts a conversation with the project's AGENTS.md and the user's own, read afresh. Returns
// the instructions files it follows, for the banner, like ["AGENTS.md"].
function newConversation() {
  const instructions = readProjectInstructions();
  const userInstructions = readUserInstructions();
  messages = createMessages({ instructions, userInstructions, sandbox: IN_SANDBOX });
  context.reset();
  session = null;
  sessionId = randomUUID();
  return [instructions != null && INSTRUCTIONS_FILE, userInstructions != null && `~/${USER_DIR}/${INSTRUCTIONS_FILE}`].filter(Boolean);
}

// Text on one line, cut to `max` characters.
function oneLine(text, max = 80) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// Saves the conversation in .agent/sessions, so that it can be continued later. `task` is the
// task that just ran, if any; the first one names the conversation in /resume's list.
function saveConversation(task) {
  if (messages.length < 2) return;
  session ??= { file: newSessionFile(), created: new Date().toISOString(), title: oneLine(task ?? "untitled"), lastTask: null, tasks: 0 };
  if (task != null) {
    session.tasks++;
    session.lastTask = oneLine(task);
  }
  const { file, ...about } = session;
  try {
    saveSession(file, { ...about, model, messages });
  } catch (error) {
    if (!saveFailed) print(warning(`Couldn't save the conversation: ${error.message}`));
    saveFailed = true;
  }
}

// Continues a saved conversation, which is saved to its own file from now on. Its system prompt
// is written afresh, since the project's AGENTS.md may have changed, so Claude's thinking from
// before no longer matches the conversation.
function resumeConversation(saved) {
  newConversation();
  messages.push(...saved.messages.slice(1));
  dropThinking(messages);
  const { file, created, title, lastTask, tasks } = saved;
  session = { file, created, title, lastTask, tasks: tasks ?? 0 };
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// "today 14:05", "yesterday 09:12" or "Nov 19 17:30", in the local time zone.
function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "some time ago";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// What a resumed conversation was about: its first and last task, and the last reply.
function showResumed(saved) {
  const tasks = saved.tasks ?? 0;
  print(`${theme.accent(glyphs.arrow)} Continuing ${theme.strong(saved.title || "untitled")} ${theme.muted(`from ${when(saved.updated)} · ${plural(tasks, "task")}`)}`);
  if (saved.lastTask && tasks > 1) print(theme.muted(`  Last task: ${saved.lastTask}`));
  const reply = messages.findLast((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim());
  if (reply) {
    const lines = reply.content.trim().split("\n");
    const shown = [...lines.slice(0, 4).map(markdownAsText), ...(lines.length > 4 ? ["…"] : [])];
    shown.forEach((line, i) => print(theme.muted(`  ${i === 0 ? "Last reply: " : ""}${line}`)));
  }
}

// The model lists load in the background. Until the model's has (or if it can't), the context
// window is assumed to be 128k tokens and the usage line shows the context in tokens, not
// percent, and the model is assumed to see images.
function loadModels(source, fetchList) {
  fetchList().then(
    (list) => {
      models = new Map([...(models ?? []), ...list]);
      listed.add(source);
      context.limit = modelInfo(models, model)?.contextLength ?? null;
    },
    () => {},
  );
}
if (openai) loadModels("openrouter", () => fetchModels(openai));
if (claude) loadModels("claude", () => fetchClaudeModels(claude));

// What the model list says about a model (by default, the one in use), for requests.
function aboutModel(name = model) {
  return modelInfo(models, name);
}

function canSeeImages(name = model) {
  return modelInfo(models, name)?.images !== false;
}

// Replies go to stdout, and everything else to stderr without a terminal (see HEADLESS).
const messageOutput = HEADLESS ? process.stderr : output;

const info = (text) => theme.muted(text);
const warning = (text) => theme.warning(`${glyphs.warn} ${text}`);
const failure = (text) => theme.danger(`${glyphs.fail} ${text}`);

// Ctrl+C cancels the running task (and drops messages entered for after it), or quits when
// the agent is idle at the prompt. Ctrl+D (end of input) closes the input: open prompts give
// up, but a running task finishes.
let activeTask = null;
let userInput = null;
if (!HEADLESS) {
  userInput = createInput({
    onQueued: () => print(info(`  ${glyphs.arrow} Queued: runs after the current task`)),
    // The up arrow brings back what was entered in this project before.
    history: loadHistory(),
    onHistory: (lines) => {
      try {
        saveHistory(lines);
      } catch {
        // A read-only project just doesn't keep its history.
      }
    },
    completer: (line) =>
      completeLine(line, {
        commands: [...COMMANDS, ...[...customCommands().keys()].map((name) => `/${name}`)],
        models: models ? [...models.keys()] : [],
      }),
    // A line ended with "\" goes on in the next one.
    continuationPrompt: `${theme.muted(glyphs.continued)} `,
    // Ctrl+R searches what was entered before: "search: pars ❯ fix the parser".
    searchPrompt: (query, { found }) => `${found ? theme.muted("search:") : theme.warning("no match:")} ${query} ${theme.accent(glyphs.prompt)} `,
  });
  userInput.onInterrupt(() => {
    // At the prompt, Ctrl+C throws away what was typed, and with nothing typed, quits.
    if (!activeTask) return userInput.discardDraft() || userInput.close();
    activeTask.abort();
    const dropped = userInput.clearQueue();
    if (dropped) print(info(`  Dropped ${plural(dropped, "queued message")}`));
  });
}

// A spinner shows what the agent is waiting on. It steps aside while the user types ahead.
const status = createStatus({
  output: HEADLESS ? { isTTY: false } : output,
  paused: () => Boolean(userInput?.typing),
  hint: "Ctrl+C to cancel",
});
userInput?.beforeKeypress(() => status.erase());

// The model's replies, rendered as markdown as they stream into a terminal. Without colors
// (NO_COLOR, say), rendering would only hide what marks code, so the markdown stays as it is.
const replyWriter = createMarkdownWriter({
  write: (text) => output.write(text),
  columns: () => output.columns || 80,
  enabled: Boolean(output.isTTY) && !HEADLESS && hasColors(),
});

// Ends the reply's line in progress, if any, so other output starts on a line of its own.
function endLine() {
  replyWriter.endLine();
}

// The usage as fields for --json: token counts by name, and the cost in dollars, if known.
function usageJson(usage) {
  return { requests: usage.requests, input_tokens: usage.input, output_tokens: usage.output, cached_tokens: usage.cached, cost: usage.cost, cost_estimated: usage.estimated };
}

// Prints a line of output, on its own line, in place of the spinner (which comes back after).
function print(text = "") {
  status.erase();
  endLine();
  messageOutput.write(`${text}\n`);
}

function printLines(lines) {
  for (const line of lines) print(line);
}

// What was shown last in a task, for spacing: a blank line goes between the model's text and
// tool calls, and around a tool call that shows more than its own line, like a diff.
// "none" at the start of a task, then "text", "tool" (a call on one line), "details" (a call
// with lines under it) or "info" (like what a task changed).
let lastBlock = "none";

function startBlock(kind) {
  if (lastBlock !== "none" && (kind !== lastBlock || kind === "details")) print();
  lastBlock = kind;
}

// Writes streamed text from the model: markdown, or with `style` (like a dimmed summary) as it is.
function writeToken(token, style = null) {
  status.stop();
  if (lastBlock !== "text") {
    // Blank tokens before the text starts would only push it down.
    if (!token.trim()) return;
    startBlock("text");
    replyWriter.reset();
  }
  if (style) replyWriter.write(style(token), { plain: true });
  else replyWriter.write(token);
}

const WRITING = { write_file: "Writing", write_asset: "Writing", append_file: "Appending to", edit_file: "Editing", delete_file: "Deleting" };

// What a running tool is doing, like "Running the command".
function runningText({ name, args }) {
  if (name === "shell") return args?.background ? "Starting the command in the background" : "Running the command";
  if (name === "process_output") return `Waiting for output from process ${args?.id}`;
  if (name === "stop_process") return `Stopping process ${args?.id}`;
  if (name === "fetch_url") return `Fetching ${URL.parse(args?.url)?.host ?? "the page"}`;
  return `Running ${name}`;
}

// When the tool call running now started, for how long a command took.
let toolStartedAt = 0;

function activityText(activity) {
  if (activity.type === "waiting") return "Thinking";
  if (activity.type === "compacting") return "Summarizing the conversation to free up context";
  if (activity.type === "running") return runningText(activity);
  // A tool call streaming in, like the content of a file the model is writing.
  let doing = activity.name === "shell" ? "Preparing a command" : `Preparing ${activity.name}`;
  if (activity.path && WRITING[activity.name]) doing = `${WRITING[activity.name]} ${activity.path}`;
  return activity.chars >= 1000 ? `${doing} · ${formatTokens(activity.chars)} characters` : doing;
}

function showActivity(activity) {
  // A command's time counts from when it starts, not from when it was asked about.
  if (activity.type === "running") toolStartedAt = Date.now();
  if (!status.enabled) return;
  endLine(); // the spinner needs a line of its own
  status.set(activityText(activity));
}

function showToolCall(name, args) {
  status.stop();
  const { summary, lines } = previewToolCall(name, args);
  startBlock(lines.length ? "details" : "tool");
  print(toolCallLine(name, summary));
  printLines(detailLines(lines));
  toolStartedAt = Date.now();
}

function showToolResult(name, result) {
  status.stop();
  const lines = previewToolResult(name, result);
  // A command says how long it took, and that it worked when it did. (A command started in the
  // background ends with a note on how it is doing instead.)
  if (name === "shell" && result.status === "ok") {
    const ms = Date.now() - toolStartedAt;
    const took = ms >= 100 ? formatDuration(ms) : null; // "0.0s" would say nothing
    const ending = lines.at(-1);
    if (ending?.kind === "error") ending.text += took ? ` · ${took}` : "";
    else if (ending?.kind !== "note") lines.push({ kind: "ok", text: took ?? "done" });
  }
  if (result.status === "skipped" && !HEADLESS) lines.push({ kind: "note", text: `${glyphs.skip} Skipped` });
  if (!lines.length) return;
  if (lastBlock === "tool") lastBlock = "details";
  printLines(detailLines(lines));
}

const CONTEXT_CHANGES = {
  trimmed: () => info("Removed old tool output to make room in the model's context."),
  compacted: () => info("Summarized the earlier conversation to make room in the model's context."),
  compactFailed: ({ error }) => warning(`Couldn't summarize the earlier conversation: ${error.message}`),
};

function showContextChange(change) {
  status.stop();
  startBlock("info");
  print(CONTEXT_CHANGES[change.type](change));
}

// What happened to a reply along the way (see agentTurn and streamClaudeReply).
const NOTICES = {
  cutOff: () => info(`The reply stopped at the model's output limit. Say "continue" for the rest.`),
  fallback: ({ from, to, category }) => warning(`${from ?? "The model"} declined this${category ? ` (${category})` : ""}, so ${to ?? "another model"} took over.`),
  retry: ({ error }) => warning(`The reply broke off (${error.message}), so the agent asks again.`),
};

function showNotice(notice) {
  const line = NOTICES[notice.type]?.(notice);
  if (!line) return;
  status.stop();
  startBlock("info");
  print(line);
}

// The terminal's bell, which can flash the window or mark its tab, rings when the agent needs
// the user after working for a while, since they may have turned to something else: at a
// confirmation, or at the end of a long task. BELL=off in .env silences it.
const BELL_AFTER_CONFIRM_MS = 10_000;
const BELL_AFTER_TASK_MS = 30_000;
let taskStartedAt = 0;

function bell() {
  if (output.isTTY && !HEADLESS && process.env.BELL !== "off") output.write("\x07");
}

// Tool calls allowed for good in this project (see permissions.mjs). A rule the user adds is
// saved, or if it can't be, kept until the agent quits.
let rules = loadRules();

function describeRule(rule) {
  if (rule.startsWith("shell: ")) return `commands that start with "${rule.slice(7)}" run`;
  if (rule.startsWith("fetch_url: ")) return `pages on ${rule.slice(11)} are fetched`;
  return `${rule} runs`;
}

function allowForGood(rule) {
  rules = [...new Set([...rules, rule])];
  try {
    saveRules(rules);
    printLines(detailLines([{ kind: "ok", text: `From now on, ${describeRule(rule)} without asking here.` }]));
  } catch (error) {
    print(outcomeLine(`Allowed until you quit: the rule couldn't be saved (${error.message}).`, { style: theme.warning, symbol: glyphs.warn }));
  }
}

async function confirmTool(name, args, signal) {
  if (!needsConfirmation(name, args) || options.yes || allows(rules, name, args)) return true;
  // A command that chains others, one that does damage that can't be undone, or reading a file
  // that may hold secrets, has no "always".
  const rule = ruleFor(name, args);
  if (HEADLESS) {
    const how = rule ? 'Run with --yes, or allow it for good by answering "a" in an interactive session.' : "Run with --yes to approve it.";
    print(outcomeLine(`Skipped: it needs approval. ${how}`, { style: theme.warning, symbol: glyphs.skip }));
    return false;
  }

  if (Date.now() - taskStartedAt >= BELL_AFTER_CONFIRM_MS) bell();
  status.stop();
  endLine();
  const answer = (await userInput.ask(confirmPrompt(name, args, rule, glyphs, output.columns), signal))?.trim().toLowerCase();
  if (lastBlock === "tool") lastBlock = "details";

  if (rule && (answer === "a" || answer === "always")) {
    allowForGood(rule);
    return true;
  }
  return answer === "y" || answer === "yes";
}

// /permissions lists what runs without asking; /permissions remove <n> takes a rule back.
function permissions(argument) {
  const remove = argument.match(/^remove\s+(\d+)$/i);
  if (remove) {
    const rule = rules[Number(remove[1]) - 1];
    if (!rule) {
      print(warning(`There's no rule ${remove[1]}. /permissions lists them.`));
      return;
    }
    rules = rules.filter((other) => other !== rule);
    saveRules(rules);
    print(info(`Removed: ${describeRule(rule)} without asking.`));
    return;
  }
  if (argument) {
    print(warning("Use /permissions to list the rules, and /permissions remove <n> to remove one."));
    return;
  }

  if (options.yes) print(warning("--yes is on: every tool call runs without asking."));
  if (!rules.length) {
    print(info('Nothing runs without asking yet. Answer "a" at a confirmation to allow something for good.'));
    return;
  }
  print(theme.strong("Runs without asking in this project"));
  printLines(numberedLines(rules.map(describeRule)));
  print(info(`Remove one with /permissions remove <n>. The rules are saved in ${PERMISSIONS_FILE}.`));
}

// The file changes of each task that changed files, newest last, for /undo.
const undoStack = [];
let sessionCost = 0;
let sessionEstimated = false;

function newUsage() {
  return { requests: 0, input: 0, output: 0, cached: 0, cost: null, estimated: false };
}

function addUsage(total, usage) {
  total.requests++;
  total.input += usage.prompt_tokens ?? 0;
  total.output += usage.completion_tokens ?? 0;
  total.cached += usage.prompt_tokens_details?.cached_tokens ?? 0;
  // OpenRouter reports what the request cost; for the Claude API, it is estimated from list prices.
  if (typeof usage.cost === "number") {
    total.cost = (total.cost ?? 0) + usage.cost;
    if (usage.cost_estimated) total.estimated = true;
  }
}

// After a task or /compact: how long it took, what it cost, and how full the model's context is.
function showFooter(usage, startedAt) {
  sessionCost += usage.cost ?? 0;
  if (usage.estimated) sessionEstimated = true;
  startBlock("info");
  print(taskFooter({ elapsed: Date.now() - startedAt, usage, sessionCost, sessionEstimated, context }, messageOutput.columns));
}

// How the agent reaches a model (by default, the one in use), for agentTurn and compactMessages.
function modelOptions(name = model) {
  return { openai, claude, model: name, sessionId, modelInfo: aboutModel(name), effort, canSeeImages: canSeeImages(name) };
}

function showError(error, signal) {
  startBlock("info");
  if (signal.aborted) return print(theme.warning(`${glyphs.skip} Cancelled`));
  print(failure(error.message));
  if (isOverflowError(error)) print(info("  The conversation is too long for this model. /compact summarizes it; /clear starts over."));
}

// The files a task for `name` (a model) names, as message parts: its images (see taskImages),
// and its @-mentioned text files (see mentionParts), saying which were attached and which were
// left out.
function taskAttachments(task, name = model) {
  const parts = taskImages(task, name);
  const mentions = mentionParts(task);
  for (const part of mentions.parts) {
    parts.push({ type: "text", text: part.text });
    print(info(`${glyphs.arrow} Attached ${part.shown}`));
  }
  for (const { shown, reason } of mentions.leftOut) print(warning(`Left out ${shown}: ${reason}`));
  return parts;
}

// The images a task for `name` (a model) names (see imagePathsIn), as message parts, saying
// which were attached.
function taskImages(task, name = model) {
  const paths = imagePathsIn(task);
  if (!paths.length) return [];
  if (!canSeeImages(name)) {
    print(warning(`${name} can't see images, so the model only gets their names. /model switches to one that can.`));
    return [];
  }
  const parts = [];
  for (const path of paths) {
    try {
      parts.push(imagePart(path));
      print(info(`${glyphs.arrow} Attached ${path}`));
    } catch (error) {
      print(warning(`Couldn't attach ${error.message}`));
    }
  }
  return parts;
}

// Runs a task. `title`, if given, is what the user entered for it, like "/review src", which
// stands for it in the list of saved conversations. `taskModel`, if given, is the model for
// this task only, like the one a command's file names; the context window is that model's while
// it runs.
async function runTask(task, { title = task, model: taskModel = model } = {}) {
  const controller = new AbortController();
  const changes = new FileChanges();
  const usage = newUsage();
  const saved = [];
  lastBlock = "none";
  const attachments = taskAttachments(task, taskModel);
  activeTask = controller;
  taskStartedAt = Date.now();
  let streamed = false;
  if (taskModel !== model) context.limit = aboutModel(taskModel)?.contextLength ?? null;

  try {
    const reply = await agentTurn({
      ...modelOptions(taskModel),
      task,
      attachments,
      planMode,
      messages,
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
      onNotice: showNotice,
    });
    // Replies arrive through onToken, so only print here if nothing was streamed.
    if (!streamed && reply) {
      startBlock("text");
      print(reply);
    }
  } catch (error) {
    status.stop();
    showError(error, controller.signal);
  } finally {
    activeTask = null;
    status.stop();
    endLine();
    if (taskModel !== model) context.limit = aboutModel()?.contextLength ?? null;
  }

  const changed = changes.paths;
  if (changed.length) {
    undoStack.push(changes);
    startBlock("info");
    print(info(`Changed ${nameList(changed)} · /undo to revert`));
  }
  if (saved.length) {
    startBlock("info");
    print(info(`Saved ${nameList(saved)}`));
  }
  showFooter(usage, taskStartedAt);
  saveConversation(title);
  if (Date.now() - taskStartedAt >= BELL_AFTER_TASK_MS) bell();
}

const UNDO_RESULTS = {
  restored: (path) => `${theme.success(glyphs.ok)} Restored ${path}`,
  deleted: (path) => `${theme.success(glyphs.ok)} Deleted ${path} ${info("(the agent created it)")}`,
  kept: (path) => warning(`Kept ${path}: it changed again after the agent wrote it`),
};

function undo() {
  const changes = undoStack.pop();
  if (!changes) {
    print(info("Nothing to undo."));
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
    print(info("Nothing to compact yet."));
    return;
  }

  const controller = new AbortController();
  const usage = newUsage();
  const before = context.estimate(messages);
  const startedAt = Date.now();
  lastBlock = "none";
  activeTask = controller;
  showActivity({ type: "compacting" });
  try {
    await compactMessages({
      ...modelOptions(),
      messages,
      context,
      signal: controller.signal,
      onUsage: (requestUsage) => addUsage(usage, requestUsage),
      onToken: (token) => writeToken(token, theme.muted),
      onNotice: showNotice,
    });
    endLine();
    context.reset();
    startBlock("info");
    print(`${theme.success(glyphs.ok)} Compacted the conversation from about ${formatTokens(before)} tokens to ${formatTokens(context.estimate(messages))}.`);
  } catch (error) {
    status.stop();
    showError(error, controller.signal);
  } finally {
    activeTask = null;
    status.stop();
    endLine();
  }
  showFooter(usage, startedAt);
}

function processState(proc) {
  if (proc.running) return `running for ${formatDuration(Date.now() - proc.startedAt)}`;
  if (proc.stopped) return "stopped";
  if (proc.exit.error) return `couldn't start: ${proc.exit.error.message}`;
  return proc.exit.code != null ? `exited with code ${proc.exit.code}` : `ended by ${proc.exit.signal}`;
}

function showProcesses() {
  const { list, running } = backgroundProcesses;
  if (!list.length) {
    print(info("No background processes. The agent starts them for servers and watchers that keep running."));
    return;
  }
  print(theme.strong("Background processes"));
  const width = lineWidth(output.columns);
  for (const proc of list) {
    const state = processState(proc);
    const cmd = truncateEnd(proc.cmd, Math.max(20, width - displayWidth(`  ${proc.id}  ${state}`) - 2));
    print(`  ${theme.accent(String(proc.id))}  ${cmd}  ${proc.running ? theme.success(state) : info(state)}`);
    if (proc.lastLine) print(info(truncateEnd(`     ${glyphs.gutter} ${proc.lastLine}`, width)));
  }
  if (running.length) print(info("Stop one with /stop <number>, or all of them with /stop all."));
}

async function stopProcesses(argument) {
  if (!argument) {
    print(warning("Which one? /stop <number> stops a background process, /stop all stops them all."));
    return;
  }
  const procs = argument === "all" ? backgroundProcesses.running : [backgroundProcesses.get(argument)];
  const running = procs.filter((proc) => proc.running);
  if (!running.length) {
    print(info(argument === "all" ? "No background process is running." : `Process ${argument} isn't running.`));
    return;
  }

  await Promise.all(running.map((proc) => proc.stop()));
  const names = running.map((proc) => `${proc.id} (${proc.cmd})`).join(", ");
  const shown = running.map((proc) => `${proc.id} ${info(`(${truncateEnd(proc.cmd, 40)})`)}`).join(", ");
  print(`${theme.success(glyphs.ok)} Stopped ${running.length === 1 ? "process" : "processes"} ${shown}`);
  // Tell the model, which would otherwise expect them to be running.
  messages.push({ role: "user", content: `(I stopped background ${running.length === 1 ? "process" : "processes"} ${names}.)` });
}

// "Claude API · 1M tokens of context · sees images", as far as the model's list says.
function modelDetails() {
  const about = aboutModel();
  const details = [isClaudeModel(model) ? "Claude API" : "OpenRouter"];
  if (about?.contextLength) details.push(`${formatTokens(about.contextLength)} tokens of context`);
  if (about?.images != null) details.push(about.images ? "sees images" : "text only");
  return details.join(" · ");
}

// Warnings about a model (by default, the one in use): one its list doesn't have, or one that
// can't call tools.
function modelWarning(name = model) {
  const claudeModel = isClaudeModel(name);
  if (!listed.has(claudeModel ? "claude" : "openrouter")) return null;
  const about = aboutModel(name);
  if (!about && claudeModel) return `${name} isn't in the Claude API's model list. /model and Tab list the ones there are.`;
  if (!about) return `${name} isn't in OpenRouter's model list; check the name at openrouter.ai/models.`;
  if (about.tools === false) return `${name} can't call tools, so it can only talk: it can't read or change files, or run commands.`;
  return null;
}

// The model one of the user's commands runs with: the one its file names, if any, unless that
// one's API key isn't set; then the one in use, saying why. Warns about a model its list
// doesn't have.
function commandModel(command) {
  if (!command.model || command.model === model) return model;
  const missing = keyProblem(command.model);
  if (missing) {
    print(warning(`${missing} So /${command.name} runs with ${model}.`));
    return model;
  }
  const problem = modelWarning(command.model);
  if (problem) print(warning(problem));
  return command.model;
}

function showModel() {
  print(`${theme.accent(glyphs.tool)} ${theme.strong(model)}${info(`  ${modelDetails()}`)}`);
  const problem = modelWarning();
  if (problem) print(warning(problem));
  if (openai && claude) print(info(`Switch with /model <name>: an OpenRouter model ID, or a Claude model like ${DEFAULT_CLAUDE_MODEL}.`));
  else if (claude) print(info(`Switch with /model <name>, using a Claude model like ${DEFAULT_CLAUDE_MODEL} (Tab completes them).`));
  else print(info("Switch with /model <name>, using a model ID from openrouter.ai/models (Tab completes them)."));
}

function switchModel(name) {
  const missing = keyProblem(name);
  if (missing) {
    print(warning(missing));
    return;
  }
  model = name;
  context.limit = modelInfo(models, model)?.contextLength ?? null;
  const details = modelDetails();
  print(`${theme.success(glyphs.ok)} Using ${theme.strong(model)} from the next task on${details ? info(`  ${details}`) : ""}`);
  const problem = modelWarning();
  if (problem) print(warning(problem));
}

// Stops the background processes, which a conversation started next wouldn't know about.
async function stopForNewConversation() {
  const stopped = await backgroundProcesses.stopAll();
  if (stopped) print(info(`Stopped ${stopped === 1 ? "1 background process" : `${stopped} background processes`}.`));
}

// How many saved conversations /resume lists; /resume <words> finds the others.
const LISTED_SESSIONS = 10;

// A saved conversation in /resume's list: its title, when it was used last, and its tasks.
function sessionLine(saved) {
  const current = saved.file === session?.file ? theme.accent("  (this one)") : "";
  return `${saved.title || "untitled"}  ${info(`${when(saved.updated)} · ${plural(saved.tasks ?? 0, "task")}`)}${current}`;
}

// The saved conversation numbered `argument` in /resume's list, or null, saying why.
function savedConversation(argument) {
  const chosen = /^\d+$/.test(argument) ? listSessions()[Number(argument) - 1] : null;
  if (!chosen) print(warning(`There's no saved conversation ${argument}. /resume lists them.`));
  return chosen ?? null;
}

// /resume lists the saved conversations, used last first; /resume <n> continues one of them,
// /resume <words> finds them by what the user asked in them, and /resume delete <n> deletes one.
async function resume(argument) {
  const remove = argument.match(/^(?:delete|remove|rm)\b\s*(.*)$/i);
  if (remove) return deleteConversation(remove[1].trim());
  if (argument && !/^\d+$/.test(argument)) return findConversations(argument);

  if (!argument) {
    const sessions = listSessions();
    if (!sessions.length) {
      print(info("No saved conversations in this project yet. Each one is saved after its first task."));
      return;
    }
    print(theme.strong("Saved conversations, last used first"));
    printLines(numberedLines(sessions.slice(0, LISTED_SESSIONS).map(sessionLine)));
    const more = sessions.length - LISTED_SESSIONS;
    if (more > 0) print(info(`${plural(more, "older one")} too: /resume <words> finds conversations by their tasks.`));
    print(info("Continue one with /resume <number>, or delete it with /resume delete <number>."));
    return;
  }

  const chosen = savedConversation(argument);
  if (!chosen) return;
  const saved = loadSession(chosen.file);
  await stopForNewConversation();
  resumeConversation(saved);
  showResumed(saved);
}

// /resume <words>: the saved conversations in which the user asked for something with the words,
// each with where they are, unless its title has them all.
function findConversations(query) {
  const found = searchSessions(query);
  if (!found.length) {
    print(info(`No saved conversation has "${query}" in its tasks. /resume lists them.`));
    return;
  }
  const words = query.split(/\s+/);
  const width = Math.min(lineWidth(output.columns), 100) - 10;
  print(theme.strong(`Saved conversations with "${query}"`));
  printLines(
    numberedLines(
      found.map((saved) => (saved.match ? [sessionLine(saved), info(`${glyphs.gutter} ${excerpt(saved.match, words, width)}`)] : sessionLine(saved))),
      found.map(({ number }) => number),
    ),
  );
  print(info("Continue one with /resume <number>."));
}

// /resume delete <n>: deletes a saved conversation, once the user says so. Not the one going on,
// which would only be saved again after its next task.
async function deleteConversation(argument) {
  if (!argument) {
    print(warning("Which one? /resume delete <number> deletes a saved conversation; /resume lists them."));
    return;
  }
  const chosen = savedConversation(argument);
  if (!chosen) return;
  const title = chosen.title || "untitled";
  if (chosen.file === session?.file) {
    print(warning(`That's this conversation. /clear starts a new one; then /resume delete can delete "${title}".`));
    return;
  }

  // Ctrl+C at the question says no, rather than quitting the agent.
  const controller = new AbortController();
  activeTask = controller;
  let answer;
  try {
    answer = await userInput.ask(questionLine(`Delete "${title}"?`, `${when(chosen.updated)} · ${plural(chosen.tasks ?? 0, "task")} · y/N`), controller.signal);
  } finally {
    activeTask = null;
  }
  if (!/^y(es)?$/i.test(answer?.trim() ?? "")) {
    print(info("Kept it."));
    return;
  }
  deleteSession(chosen.file);
  print(`${theme.success(glyphs.ok)} Deleted ${theme.strong(title)}`);
}

// Runs a slash command. Resolves to false when the CLI should quit.
async function runCommand(line) {
  const command = line.split(/\s+/)[0].toLowerCase();
  const argument = line.slice(command.length).trim();

  if (command === "/exit" || command === "/quit") return false;

  if (command === "/help") {
    const name = argument.split(/\s+/)[0]?.replace(/^\//, "").toLowerCase() ?? "";
    const own = name ? customCommands().get(name) : null;
    if (own) {
      printLines(commandLines(own, commandPath(own)));
    } else if (!name || COMMANDS.includes(`/${name}`)) {
      const { commands, skipped } = loadCommands({ builtIn: COMMANDS });
      printLines(helpLines(output.columns, glyphs, [...commands.values()], skipped.map((s) => ({ file: commandPath(s), reason: s.reason }))));
    } else {
      const near = nearCommand(name, [...customCommands().keys()]);
      print(warning(`No command /${name}.${near ? ` Did you mean /${near}?` : " Type /help for commands."}`));
    }
  } else if (command === "/clear") {
    await stopForNewConversation();
    const following = newConversation();
    print(`${theme.success(glyphs.ok)} Started a new conversation${following.length ? info(` (following ${following.join(" and ")})`) : ""}. ${info("/resume goes back to an earlier one.")}`);
  } else if (command === "/resume") {
    await resume(argument);
  } else if (command === "/permissions") {
    permissions(argument);
  } else if (command === "/plan") {
    planMode = !planMode;
    print(
      planMode
        ? `${theme.plan("Plan mode on:")} ${info("the agent looks around and replies with a plan, changing nothing.")}`
        : `${theme.success("Plan mode off:")} ${info("the agent can make changes again (they still ask first).")}`,
    );
  } else if (command === "/processes") {
    showProcesses();
  } else if (command === "/stop") {
    await stopProcesses(argument);
  } else if (command === "/compact") {
    await compact();
  } else if (command === "/undo") {
    undo();
  } else if (command === "/model" && argument) {
    switchModel(argument);
  } else if (command === "/model") {
    showModel();
  } else {
    const near = nearCommand(command.slice(1), [...COMMANDS.map((name) => name.slice(1)), ...customCommands().keys()]);
    print(warning(`Unknown command ${command}.${near ? ` Did you mean /${near}?` : " Type /help for commands."}`));
  }
  // /undo, /compact and /stop tell the model something; keep that in the saved conversation.
  if (["/undo", "/compact", "/stop"].includes(command)) saveConversation();
  return true;
}

const following = newConversation();
// In the sandbox, the project is at /workspace; show the folder it is on the host.
const projectDir = IN_SANDBOX ? process.env.PHI_AGENT_HOST_PROJECT || process.cwd() : process.cwd();

// The project folder as the banner shows it: in the home folder, from ~.
function shownPath(path) {
  const home = homedir();
  if (!home || IN_SANDBOX) return path;
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

// --continue: the conversation saved last in this project.
let continued = null;
if (options.continue) {
  const latest = listSessions()[0];
  try {
    continued = latest && loadSession(latest.file);
  } catch (error) {
    print(warning(error.message));
  }
}

if (continued) {
  resumeConversation(continued);
} else if (options.continue) {
  print(info("There's no saved conversation in this project yet, so this is a new one."));
}

// How long --print waits for piped input to start when the task was given as an argument too.
// Some parents leave the agent's input open without ever writing to it.
const PIPED_INPUT_WAIT_MS = 3000;

// What was piped in, for --print: `git diff | phi-agent -p "review this"`. Without a task
// argument, the input is the task, so it waits for all of it.
function readPipedInput({ hasTask }) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    };
    const timer = hasTask
      ? setTimeout(() => {
          if (chunks.length) return;
          process.stdin.destroy();
          done();
        }, PIPED_INPUT_WAIT_MS)
      : null;
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

// --print: runs one task and writes the model's reply to stdout. Resolves to the exit code: 0
// when the task ran, 1 when it failed, 2 without a task, 130 when cancelled with Ctrl+C.
async function runPrint() {
  const entered = [firstTask, await readPipedInput({ hasTask: Boolean(firstTask) })].filter(Boolean).join("\n\n");
  if (!entered) {
    print(failure("--print needs a task: give it as an argument, or pipe it in."));
    if (options.json) output.write(`${JSON.stringify({ ok: false, error: "--print needs a task: give it as an argument, or pipe it in." })}\n`);
    return 2;
  }
  // One of the user's own commands runs its prompt, with what was piped in as its arguments, and
  // with the model its file names, if any: for this one task, that is the model.
  const own = findCommand(entered, customCommands());
  const task = own ? commandTask(own.command, own.args) : entered;
  if (own) {
    model = commandModel(own.command);
    context.limit = aboutModel()?.contextLength ?? null;
  }

  const controller = new AbortController();
  // Ctrl+C cancels the task, stopping the request or command it is waiting on; twice quits.
  process.on("SIGINT", () => (controller.signal.aborted ? process.exit(130) : controller.abort()));
  const changes = new FileChanges();
  const usage = newUsage();
  const startedAt = Date.now();
  let progress = ""; // what the model writes before calling tools, which isn't the reply
  let exitCode = 0;

  try {
    const reply = await agentTurn({
      ...modelOptions(),
      task,
      attachments: taskAttachments(task),
      planMode,
      messages,
      changes,
      context,
      confirmTool,
      signal: controller.signal,
      onToken: (token) => (progress += token),
      onToolCall: (name, args) => {
        if (progress.trim()) {
          startBlock("text");
          print(info(progress.trim()));
        }
        progress = "";
        showToolCall(name, args);
      },
      onToolResult: showToolResult,
      onUsage: (requestUsage) => addUsage(usage, requestUsage),
      onContextChange: showContextChange,
      onNotice: showNotice,
    });
    if (options.json) {
      output.write(`${JSON.stringify({ ok: true, reply, task: entered, model, usage: usageJson(usage), changes: changes.paths, elapsed_ms: Date.now() - startedAt })}\n`);
    } else if (reply) {
      output.write(reply.endsWith("\n") ? reply : `${reply}\n`);
    }
  } catch (error) {
    showError(error, controller.signal);
    exitCode = controller.signal.aborted ? 130 : 1;
    if (options.json) {
      output.write(`${JSON.stringify({ ok: false, error: error.message, task: entered, model, usage: usageJson(usage), changes: changes.paths, elapsed_ms: Date.now() - startedAt })}\n`);
    }
  }

  if (changes.paths.length) {
    startBlock("info");
    print(info(`Changed ${nameList(changes.paths)}`));
  }
  showFooter(usage, startedAt);
  saveConversation(entered);
  await backgroundProcesses.stopAll();
  return exitCode;
}

// The prompt: "❯ ", or "plan ❯ " in plan mode.
function prompt() {
  const mark = theme.accent(theme.strong(glyphs.prompt));
  return planMode ? `${theme.plan("plan")} ${mark} ` : `${mark} `;
}

// Runs what the user entered: a command, one of their own commands, or a task. Resolves to
// false when the CLI should quit.
async function handleInput(line) {
  // "/help" is a command; "/src/app.js is broken" is a task.
  if (!isCommandLine(line)) {
    print();
    await runTask(line);
    print();
    return true;
  }

  const own = findCommand(line, customCommands());
  if (own) {
    print();
    const taskModel = commandModel(own.command);
    const using = taskModel === model ? "" : `, with ${taskModel}`;
    print(info(`${glyphs.arrow} /${own.command.name}, from ${commandPath(own.command)}${using}`));
    await runTask(commandTask(own.command, own.args), { title: line, model: taskModel });
    print();
    return true;
  }

  let going = true;
  try {
    going = await runCommand(line.split("\n")[0]);
  } catch (error) {
    print(failure(error.message));
  }
  print();
  return going;
}

async function runInteractive() {
  printLines(
    banner(
      { version: VERSION, model, project: shownPath(projectDir), following, sandbox: IN_SANDBOX, plan: planMode, yes: options.yes },
      output.columns,
    ),
  );
  if (continued) showResumed(continued);
  print();

  let going = true;
  if (firstTask) {
    print(`${prompt()}${firstTask}`);
    going = await handleInput(firstTask);
  }

  while (going) {
    const text = await userInput.next(prompt());
    if (text == null) break;
    const line = text.trim();
    if (line) going = await handleInput(line);
  }

  const stopped = await backgroundProcesses.stopAll();
  if (stopped) print(info(`Stopped ${stopped === 1 ? "1 background process" : `${stopped} background processes`}.`));
  userInput.close();
}

if (HEADLESS) {
  process.exitCode = await runPrint();
} else {
  await runInteractive();
}
