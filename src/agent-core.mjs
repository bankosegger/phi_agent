import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeRequest, dropThinking, isClaudeModel, streamClaudeReply } from "./claude.mjs";
import { ContextWindow } from "./context.mjs";
import { checkToolCall, runTool, toolsFor } from "./tools.mjs";

const DEFAULT_MAX_TOOL_ROUNDS = 25;
const MAX_INSTRUCTIONS = 20_000;
export const DEFAULT_MODEL = "openai/gpt-4o-mini";
export const INSTRUCTIONS_FILE = "AGENTS.md";
export const CANCELLED = "cancelled by user";
export const SKIPPED = "skipped by user";

// The tools that only look around: all a helper (see runSubagent) has.
const LOOKING_TOOLS = new Set(["read_file", "list_dir", "find_files", "grep", "git", "view_image", "fetch_url", "web_search", "process_output"]);
// Plan mode: the model looks around and replies with a plan, changing nothing. Only these tools
// run: those that look around, the to-do list, which only the user sees, and helpers, which only
// look around too. The others are refused, though still offered, since some providers reject a
// request whose history has calls to tools it doesn't list.
const PLAN_TOOLS = new Set([...LOOKING_TOOLS, "todo_write", "subagent"]);
export const PLAN_NOTE =
  "(Plan mode: look around as much as you need, but change nothing: no file changes, and no commands. Reply with a plan of what you would do and why, for me to approve.)";
const PLAN_REFUSAL = "plan mode is on, so nothing can be changed or run yet: put this step in your plan instead";
const HELPER_REFUSAL = "a helper only looks around: it can't change files or run commands";

// The user's own settings folder, in their home folder: ~/.phi-agent.
export const USER_DIR = ".phi-agent";

function readInstructions(path) {
  let text;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (!text) return null;
  return text.length > MAX_INSTRUCTIONS ? `${text.slice(0, MAX_INSTRUCTIONS)}\n[truncated]` : text;
}

// The project's AGENTS.md (a README for coding agents: how to build, test, conventions), or
// null if it has none.
export function readProjectInstructions(cwd = process.cwd()) {
  return readInstructions(join(cwd, INSTRUCTIONS_FILE));
}

// The user's own AGENTS.md in ~/.phi-agent, for all their projects (like how they like to
// work, or what their machine has), or null if they have none.
export function readUserInstructions(home = homedir()) {
  return readInstructions(join(home, USER_DIR, INSTRUCTIONS_FILE));
}

// The date where the user is, like 2026-11-22 (toISOString would give the date in UTC).
function localDate(date) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function systemPrompt({
  cwd = process.cwd(),
  platform = process.platform,
  date = new Date(),
  instructions = null,
  userInstructions = null,
  sandbox = false,
} = {}) {
  const shell = platform === "win32" ? "cmd.exe" : "/bin/sh";

  const lines = [
    "You are a basic coding agent. Use tools to inspect and change project files.",
    "Prefer read_file, list_dir, find_files, grep and git over shell for exploring the project, and web_search to find pages on the web, then fetch_url over curl to read them. Use edit_file for small changes to existing files.",
    "Delete, move and rename files and folders with delete_file and move_file rather than shell, so the user can undo it.",
    "For a task of several steps, keep a to-do list with todo_write and update it as you go, so the user can follow your progress.",
    "Hand searches and research that would take many reads, like where something is used or how a part of the project works, to a helper with subagent: it looks around in a context of its own and replies with what it found, which keeps this conversation short.",
    "Start servers and watchers that keep running with shell's background option, check on them with process_output, and stop them with stop_process when you no longer need them, unless the user wants them left running.",
    "New files can't be created at the project root: put them in a folder like src/. Existing root files, like package.json or README.md, can be edited. Save generated output that isn't project source, like a report or an export, with write_asset.",
    `The user can decline file changes and shell commands. When a tool result is "${SKIPPED}", do not retry it; ask the user what they want instead.`,
    "",
    `Project directory: ${cwd}`,
    `Platform: ${platform}; the shell tool runs commands with ${shell}.`,
    `Today's date: ${localDate(date)}`,
  ];
  if (sandbox) {
    lines.push(
      "You run in a Docker sandbox: the project is mounted from the user's computer, and nothing else on it is reachable.",
      "The project's .git is read-only here, so you can't commit; the user does that. In a Node project, node_modules is separate from the user's: run npm install if packages are missing.",
    );
  }
  if (userInstructions) {
    lines.push("", `Instructions from the user's own ${INSTRUCTIONS_FILE}, for all their projects:`, "", userInstructions);
  }
  if (instructions) {
    const order = userInstructions ? "; where they disagree with the user's own, follow these" : "";
    lines.push("", `Instructions from the project's ${INSTRUCTIONS_FILE}. Follow them unless the user says otherwise${order}:`, "", instructions);
  }
  return lines.join("\n");
}

/**
 * The system prompt of a helper (see the subagent tool): it has one task, looks around for it,
 * and reports what it found to the agent that asked.
 */
export function subagentPrompt({ cwd = process.cwd(), platform = process.platform, date = new Date() } = {}) {
  return [
    "You are a helper of a coding agent, which gave you one task. Do it by looking around the project with your tools, and on the web if the task needs it. You can't change anything: no file changes, and no commands.",
    "Search before you read, and read only what the task needs.",
    "Then reply to the agent with what you found: a short report, with file paths and line numbers, and the code that matters. The agent sees only your reply, not your tool calls.",
    "",
    `Project directory: ${cwd}`,
    `Platform: ${platform}`,
    `Today's date: ${localDate(date)}`,
  ].join("\n");
}

// A new conversation. Its system prompt includes the project's AGENTS.md and the user's own,
// unless `instructions` or `userInstructions` is given (null for none).
export function createMessages({ instructions, userInstructions, ...env } = {}) {
  const cwd = env.cwd ?? process.cwd();
  return [
    {
      role: "system",
      content: systemPrompt({
        ...env,
        cwd,
        instructions: instructions === undefined ? readProjectInstructions(cwd) : instructions,
        userInstructions: userInstructions === undefined ? readUserInstructions() : userInstructions,
      }),
    },
  ];
}

function unescapeJsonString(text) {
  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text;
  }
}

// What the model is writing while a tool call streams in: the tool, the file once its path has
// arrived, and how many characters of arguments have come so far.
function toolActivity(call) {
  const path = call.function.arguments.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  return { type: "tool", name: call.function.name, path: path == null ? null : unescapeJsonString(path), chars: call.function.arguments.length };
}

// How a reply from OpenRouter stopped, as requestReply says it: finish_reason "length" means it
// reached the output limit, and "content_filter" that the provider filtered it.
const STOPS = { length: "cut_off", content_filter: "refusal" };

async function collectStream(stream, { onToken, onUsage, onActivity }) {
  let content = "";
  let finish = null;
  const toolCalls = [];

  for await (const chunk of stream) {
    // Token counts (and, from OpenRouter, the cost) arrive in a last chunk with no choices.
    if (chunk.usage) onUsage?.(chunk.usage);
    finish = chunk.choices?.[0]?.finish_reason ?? finish;

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
      onActivity?.(toolActivity(call));
    }
  }

  const message = { role: "assistant", content: content || null };
  const calls = toolCalls.filter(Boolean);
  if (calls.length) message.tool_calls = calls;
  return { message, stop: STOPS[finish] ?? "done" };
}

function logToolCall(name, args) {
  console.log(`\n[tool] ${name} ${JSON.stringify(args)}`);
}

function parseArguments(json) {
  const args = JSON.parse(json || "{}");
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("arguments must be a JSON object");
  return args;
}

// The last tool call of a reply that reached the model's output limit may be missing the end of
// its arguments, so it doesn't run.
const CUT_OFF_REFUSAL =
  "your reply reached the output limit before this call was complete, so it didn't run. Make the call again with less in it: write a long file in parts, with write_file and then append_file";

// Resolves to { status: "ok" | "error" | "skipped" | "cancelled", content, parts }, where content
// is what the model is told, and parts (from view_image) are message parts to show it after.
// A call that was `cutOff` is only announced. A helper (`readOnly`) only looks around; a call to
// start one runs `runSubagent(args)`.
async function callTool(call, { confirmTool, onToolCall, onActivity, signal, changes, planMode, readOnly, moreTools, runSubagent, cutOff = false }) {
  const cancelled = { status: "cancelled", content: CANCELLED };
  if (signal?.aborted) return cancelled;

  const { name } = call.function;
  let args;
  try {
    args = parseArguments(call.function.arguments);
  } catch (error) {
    // Announce the call anyway (with null args), so its error is not shown as the previous call's.
    onToolCall(name, null);
    return { status: "error", content: cutOff ? `error: ${CUT_OFF_REFUSAL}` : `error: invalid arguments: ${error.message}` };
  }

  try {
    onToolCall(name, args);
    if (cutOff) return { status: "error", content: `error: ${CUT_OFF_REFUSAL}` };
    if (readOnly && !LOOKING_TOOLS.has(name)) return { status: "error", content: `error: ${HELPER_REFUSAL}` };
    if (planMode && !PLAN_TOOLS.has(name)) return { status: "error", content: `error: ${PLAN_REFUSAL}` };
    // A call that would fail anyway, like an edit of text that isn't in the file, is reported
    // without asking the user to approve it.
    checkToolCall(name, args);

    const approved = await confirmTool(name, args, signal);
    // The task may have been cancelled while the user was being asked.
    if (signal?.aborted) return cancelled;
    if (!approved) return { status: "skipped", content: SKIPPED };

    // A cancelled shell command still returns its output so far, which the model should see.
    onActivity?.({ type: "running", name, args });
    let result;
    if (name === "subagent") result = await runSubagent(args);
    else if (moreTools?.has(name)) result = await moreTools.run(name, args, { signal });
    else result = await runTool(name, args, { signal, changes });
    const { content, parts } = typeof result === "object" && result !== null ? result : { content: String(result) };
    return { status: signal?.aborted ? "cancelled" : "ok", content, ...(parts && { parts }) };
  } catch (error) {
    // An abort while confirming rejects the prompt; report it as a cancel, not a tool error.
    return signal?.aborted ? cancelled : { status: "error", content: `error: ${error.message}` };
  }
}

const SUMMARY_REQUEST = [
  "Summarize our conversation so far. Your summary will replace the earlier messages, which are being removed to save context space, so write it for yourself and keep what you need to carry on:",
  "what I asked for and my preferences, what you did (files read and changed, commands run, their results), decisions and why, open problems, and what is left to do.",
  "Keep exact file paths, names and error messages. Reply with the summary only.",
].join(" ");
const SUMMARY_NOTE = "Summary of our earlier conversation (the messages it replaces were removed to save context space):";

const IMAGE_OMITTED = "[an image was here, but this model can't see images]";

// The conversation as a model that can't see images gets it: its images replaced with a note.
// (They come from earlier, with a model that could.)
function withoutImages(messages) {
  return messages.map((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")
      ? { ...message, content: message.content.map((part) => (part.type === "image_url" ? { type: "text", text: IMAGE_OMITTED } : part)) }
      : message,
  );
}

// The messages and tools to send a model, depending on whether it can see images, with the tools
// of `moreTools` (see agentTurn) after the agent's own. A helper (`readOnly`) has only the tools
// that look around.
function forModel(messages, { canSeeImages = true, moreTools = null, readOnly = false } = {}) {
  const tools = readOnly
    ? toolsFor({ images: canSeeImages }).filter((tool) => LOOKING_TOOLS.has(tool.function.name))
    : [...toolsFor({ images: canSeeImages }), ...(moreTools?.tools ?? [])];
  return { messages: canSeeImages ? messages : withoutImages(messages), tools };
}

// A request to OpenRouter. Claude caches a prompt only where it is marked, so for Claude models
// the system prompt is (with the tools before it, the same in every request), and so is the end
// of the conversation, with the top-level mark, which moves along as the conversation grows:
// each request reads what the one before it wrote. Other models cache by themselves.
// `sessionId` keeps a conversation's requests with the provider that has its prompt cached.
export function openRouterRequest({ model, messages, tools, toolChoice = null, sessionId = null }) {
  // Content blocks from the Claude API (see claude.mjs) are for the Claude API only.
  const shown = messages.map((message) => {
    if (!message.claude) return message;
    const { claude, ...rest } = message;
    return rest;
  });
  const request = { model, messages: shown, tools, stream: true, stream_options: { include_usage: true } };
  if (toolChoice) request.tool_choice = toolChoice;
  if (sessionId) request.session_id = sessionId;
  if (/^anthropic\//i.test(model)) {
    request.cache_control = { type: "ephemeral" };
    const [system, ...rest] = shown;
    if (system?.role === "system" && typeof system.content === "string") {
      request.messages = [{ ...system, content: [{ type: "text", text: system.content, cache_control: { type: "ephemeral" } }] }, ...rest];
    }
  }
  return request;
}

/**
 * One model request: to the Claude API for a Claude model like claude-opus-5-5 (with the `claude`
 * client), and otherwise to OpenRouter (with `openai`). Resolves to { message, stop, refusal }:
 * the reply as an assistant message, and how it stopped: "done", "cut_off" (at the model's
 * output limit), or "refusal" (the model declined, or its provider filtered the reply).
 */
async function requestReply({
  openai,
  claude,
  model,
  messages,
  canSeeImages = true,
  toolChoice = null,
  context,
  signal,
  onToken,
  onUsage,
  onActivity,
  onNotice,
  sessionId = null,
  modelInfo = null,
  effort = null,
  moreTools = null,
  readOnly = false,
}) {
  onActivity?.({ type: "waiting" });
  const request = forModel(messages, { canSeeImages, moreTools, readOnly });
  const measure = (usage) => {
    context?.measure(request.messages, usage);
    onUsage?.(usage);
  };
  if (isClaudeModel(model)) {
    if (!claude) throw new Error(`${model} is a Claude API model, which needs ANTHROPIC_API_KEY to be set.`);
    return streamClaudeReply({
      client: claude,
      request: claudeRequest({ model, ...request, toolChoice, about: modelInfo, effort }),
      signal,
      onToken,
      onToolInput: (call) => onActivity?.(toolActivity(call)),
      onUsage: measure,
      onNotice,
    });
  }
  if (!openai) throw new Error(`${model} is an OpenRouter model, which needs OPENROUTER_API_KEY to be set.`);
  const stream = await openai.chat.completions.create(openRouterRequest({ model, ...request, toolChoice, sessionId }), { signal });
  return collectStream(stream, { onToken, onActivity, onUsage: measure });
}

function refusalError(model, refusal) {
  const why = refusal?.category ? ` (${refusal.category})` : "";
  return new Error(`${model} declined this request${why}. Rephrase it, or try another model with /model.`);
}

// Leaves out the oldest messages of a summary request until it fits the context window, a whole
// turn at a time so that tool calls keep their results. Old tool output is trimmed first, and
// the summary from an earlier compaction is kept: it stands for everything before it.
// The request shares its messages with the conversation, so trimming them trims the
// conversation too, which Claude's thinking no longer matches then.
function fitSummaryRequest(request, context) {
  if (!context.isFull(request)) return;
  if (context.trim(request)) dropThinking(request);
  const first = request[1]?.content?.startsWith?.(SUMMARY_NOTE) ? 2 : 1;
  while (context.isFull(request)) {
    const nextTurn = request.findIndex((message, i) => i > first && message.role === "user");
    if (nextTurn === -1 || nextTurn === request.length - 1) return; // only the last turn is left
    request.splice(first, nextTurn - first);
  }
}

/**
 * Has the model summarize messages[1..upTo) (by default, all but the system prompt) and puts the
 * summary in their place. Returns how many messages it replaced. With a ContextWindow as
 * `context`, a conversation too long to summarize whole is shortened first. The clients and
 * settings are those of agentTurn.
 */
export async function compactMessages({
  openai,
  claude,
  model = process.env.MODEL || DEFAULT_MODEL,
  messages,
  upTo = messages.length,
  canSeeImages = true,
  context,
  signal,
  onToken,
  onUsage,
  onNotice,
  sessionId,
  modelInfo,
  effort,
  moreTools,
  readOnly,
}) {
  if (upTo < 2) return 0;
  const request = [...messages.slice(0, upTo), { role: "user", content: SUMMARY_REQUEST }];
  if (context) fitSummaryRequest(request, context);

  // The tools are sent because the history has tool calls, but the model may not call them now.
  const reply = await requestReply({
    openai,
    claude,
    model,
    messages: request,
    canSeeImages,
    toolChoice: "none",
    signal,
    onToken,
    onUsage,
    onNotice,
    sessionId,
    modelInfo,
    effort,
    moreTools,
    readOnly,
  });
  signal?.throwIfAborted();
  if (reply.stop === "refusal") throw refusalError(model, reply.refusal);

  const summary = reply.message.content?.trim();
  if (!summary) throw new Error("the model replied without a summary");
  messages.splice(1, upTo - 1, { role: "user", content: `${SUMMARY_NOTE}\n\n${summary}` });
  // Claude's thinking in the messages after the summary was about the conversation before it.
  dropThinking(messages);
  return upTo - 1;
}

// Before a request: when the conversation would fill too much of the context window, trims old
// tool output, and if that isn't enough, has the model summarize the tasks before this one.
// After a request that was too long anyway (`overflowed`), it also trims the newest output.
// Returns where the current task now starts in `messages`.
async function makeRoom({ taskStart, overflowed = false, ...options }) {
  const { context, messages, signal, onActivity, onContextChange } = options;
  if (!context?.isFull(messages)) return taskStart;

  // Claude's thinking no longer matches a conversation that was trimmed, so it goes too.
  const trimmed = context.trim(messages);
  if (trimmed) {
    dropThinking(messages);
    onContextChange?.({ type: "trimmed", count: trimmed });
  }

  if (context.isFull(messages) && taskStart > 2) {
    onActivity?.({ type: "compacting" });
    try {
      // The summary is for the model, not printed as its reply.
      const count = await compactMessages({ ...options, onToken: undefined, upTo: taskStart });
      onContextChange?.({ type: "compacted", count });
      taskStart = 2; // after the system prompt and the summary
    } catch (error) {
      if (signal?.aborted) throw error;
      // Carry on without the summary: the request may still fit.
      onContextChange?.({ type: "compactFailed", error });
    }
  }

  if (overflowed && context.isFull(messages)) {
    const count = context.trim(messages, { keepNewest: false });
    if (count) {
      dropThinking(messages);
      onContextChange?.({ type: "trimmed", count });
    }
  }
  return taskStart;
}

/**
 * Runs one user task until the model replies without tool calls, or for at most `maxRounds`
 * model requests (MAX_TOOL_ROUNDS in the environment, default 25).
 * `onToolCall(name, args)` is told about each tool call before it is confirmed and run (args is
 * null if the model sent invalid arguments), and `onToolResult(name, { status, content })`
 * about how it went. `onUsage(usage)` gets the token usage of each model request.
 * `onActivity(activity)` hears what the agent is waiting on, for a progress display:
 * { type: "waiting" } for the model, { type: "tool", name, path, chars } while a tool call
 * streams in, { type: "running", name } while a tool runs, and { type: "compacting" }.
 * With a ContextWindow as `context`, the conversation is kept inside the model's context window,
 * and `onContextChange({ type, count })` hears when old tool output was "trimmed" or earlier
 * messages "compacted" into a summary.
 * File changes are recorded in `changes` (a FileChanges), if given, so they can be undone.
 * `attachments` are message parts to send with the task, like image parts (see imagePart in
 * images.mjs) or @-mentioned files (see mentionParts in mentions.mjs). Unless
 * `canSeeImages` is false, the model gets the view_image tool; if it is false, images earlier in
 * the conversation are left out of requests. In `planMode`, the model is asked for a plan, and
 * only tools that look around run.
 * A Claude model like claude-opus-5-5 is asked through the Claude API with the `claude` client
 * (an Anthropic), with `modelInfo` (what fetchClaudeModels says about it) and an `effort` level,
 * if given; other models through OpenRouter with `openai`, keeping to the provider of
 * `sessionId`. `onNotice(notice)` hears { type: "cutOff" } when a reply stopped at the model's
 * output limit, and the notices of streamClaudeReply in claude.mjs. When the model declines a
 * request, the turn rejects with an error that says so.
 * `moreTools` offers the model tools besides the agent's own, like MCP servers' (see mcp.mjs):
 * { tools (defined as in tools.mjs), has(name), run(name, args, { signal }) }, where run resolves
 * as runTool does. They are confirmed like the agent's own, and refused in plan mode.
 * The subagent tool starts a helper: a turn of its own, in a conversation of its own, with the
 * same model and only the tools that look around (`readOnly`). The model gets its reply; the
 * user hears of its tool calls through the same callbacks, with a third argument,
 * { subagent: true }, and of what it waits on with `subagent: true` in the activity.
 * `onNotice` hears { type: "stopped", rounds } when the turn stops after `maxRounds`.
 * Aborting `signal` stops the turn and rejects with the signal's reason. Every tool call
 * already in `messages` still gets a result, so the conversation can continue afterwards.
 */
export async function agentTurn({
  task,
  attachments = [],
  canSeeImages = true,
  planMode = false,
  openai,
  claude,
  messages,
  confirmTool,
  onToolCall = logToolCall,
  onToolResult,
  onToken,
  onUsage,
  onActivity,
  onContextChange,
  onNotice,
  changes,
  context,
  signal,
  model = process.env.MODEL || DEFAULT_MODEL,
  maxRounds = Number(process.env.MAX_TOOL_ROUNDS) || DEFAULT_MAX_TOOL_ROUNDS,
  sessionId = null,
  modelInfo = null,
  effort = null,
  moreTools = null,
  readOnly = false,
}) {
  let taskStart = messages.length;
  const text = planMode ? `${PLAN_NOTE}\n\n${task}` : task;
  messages.push({ role: "user", content: attachments.length ? [{ type: "text", text }, ...attachments] : text });
  const options = {
    openai,
    claude,
    model,
    messages,
    canSeeImages,
    context,
    signal,
    onToken,
    onUsage,
    onActivity,
    onContextChange,
    onNotice,
    sessionId,
    modelInfo,
    effort,
    moreTools,
    readOnly,
  };
  const helper = { openai, claude, model, canSeeImages, sessionId, modelInfo, effort, maxRounds, context, signal, confirmTool, onToolCall, onToolResult, onUsage, onActivity, onNotice };
  const runSubagent = (args) => subagentTurn(args, helper);

  for (let i = 0; i < maxRounds; i++) {
    signal?.throwIfAborted();
    taskStart = await makeRoom({ ...options, taskStart });

    let reply;
    try {
      reply = await requestReply(options);
    } catch (error) {
      // Too long for the model after all: make room in the window the error states, and retry once.
      if (signal?.aborted || !context?.overflowed(error, messages)) throw error;
      taskStart = await makeRoom({ ...options, taskStart, overflowed: true });
      reply = await requestReply(options);
    }
    // The OpenAI SDK ends an aborted stream quietly instead of throwing; drop the partial reply.
    signal?.throwIfAborted();
    // What the model wrote before it declined is left out of the conversation.
    if (reply.stop === "refusal") throw refusalError(model, reply.refusal);
    const { message } = reply;
    messages.push(message);

    if (!message.tool_calls) {
      if (reply.stop === "cut_off") onNotice?.({ type: "cutOff" });
      return message.content ?? "";
    }

    // Images that tools opened follow the results, since a tool result can only be text and
    // nothing may come between a tool call and its result.
    const parts = [];
    const last = message.tool_calls.at(-1);
    for (const call of message.tool_calls) {
      const cutOff = reply.stop === "cut_off" && call === last;
      const result = await callTool(call, { confirmTool, onToolCall, onActivity, signal, changes, planMode, readOnly, moreTools, runSubagent, cutOff });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      if (result.parts) parts.push(...result.parts);
      onToolResult?.(call.function.name, result);
    }
    if (parts.length) messages.push({ role: "user", content: parts });
  }

  signal?.throwIfAborted();
  onNotice?.({ type: "stopped", rounds: maxRounds });
  const stopped = `Stopped after ${maxRounds} tool rounds. Say "continue" to keep going.`;
  onToken?.(stopped);
  return stopped;
}

// Runs a helper for the subagent tool (see agentTurn): its own conversation, the same model, the
// tools that look around, and a context window of its own size. Resolves to its reply, for the
// model; throws if it ran out of tool rounds, with what it had written by then.
async function subagentTurn({ task }, { context, onToolCall, onToolResult, onActivity, onNotice, ...turn }) {
  let stopped = false;
  const messages = [{ role: "system", content: subagentPrompt() }];
  const reply = await agentTurn({
    ...turn,
    task,
    messages,
    readOnly: true,
    context: context ? new ContextWindow({ limit: context.limit }) : undefined,
    onToolCall: (name, args) => onToolCall?.(name, args, { subagent: true }),
    onToolResult: (name, result) => onToolResult?.(name, result, { subagent: true }),
    onActivity: (activity) => onActivity?.({ ...activity, subagent: true }),
    onNotice: (notice) => {
      if (notice.type === "stopped") stopped = true;
      else onNotice?.(notice);
    },
  });
  if (stopped) {
    const notes = messages.findLast((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim())?.content.trim();
    throw new Error(`the helper stopped after ${turn.maxRounds} tool rounds without finishing: ask it something narrower, or look yourself.${notes ? ` Its last notes: ${notes}` : ""}`);
  }
  return reply.trim() || "(the helper replied with nothing)";
}
