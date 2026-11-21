import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolCall, runTool, tools } from "./tools.mjs";

const DEFAULT_MAX_TOOL_ROUNDS = 25;
const MAX_INSTRUCTIONS = 20_000;
export const DEFAULT_MODEL = "openai/gpt-4o-mini";
export const INSTRUCTIONS_FILE = "AGENTS.md";
export const CANCELLED = "cancelled by user";
export const SKIPPED = "skipped by user";

// The project's AGENTS.md (a README for coding agents: how to build, test, conventions), or
// null if it has none.
export function readProjectInstructions(cwd = process.cwd()) {
  let text;
  try {
    text = readFileSync(join(cwd, INSTRUCTIONS_FILE), "utf8").trim();
  } catch {
    return null;
  }
  if (!text) return null;
  return text.length > MAX_INSTRUCTIONS ? `${text.slice(0, MAX_INSTRUCTIONS)}\n[truncated]` : text;
}

export function systemPrompt({ cwd = process.cwd(), platform = process.platform, date = new Date(), instructions = null, sandbox = false } = {}) {
  const shell = platform === "win32" ? "cmd.exe" : "/bin/sh";

  const lines = [
    "You are a basic coding agent. Use tools to inspect and change project files.",
    "Prefer read_file, list_dir, find_files, grep and git over shell for exploring the project. Use edit_file for small changes to existing files.",
    "New files can't be created at the project root: put them in a folder like src/. Existing root files, like package.json or README.md, can be edited. Save generated output that isn't project source, like a report or an export, with write_asset.",
    `The user can decline file changes and shell commands. When a tool result is "${SKIPPED}", do not retry it; ask the user what they want instead.`,
    "",
    `Project directory: ${cwd}`,
    `Platform: ${platform}; the shell tool runs commands with ${shell}.`,
    `Today's date: ${date.toISOString().slice(0, 10)}`,
  ];
  if (sandbox) {
    lines.push(
      "You run in a Docker sandbox: the project is mounted from the user's computer, and nothing else on it is reachable.",
      "The project's .git is read-only here, so you can't commit; the user does that. In a Node project, node_modules is separate from the user's: run npm install if packages are missing.",
    );
  }
  if (instructions) {
    lines.push("", `Instructions from the project's ${INSTRUCTIONS_FILE}. Follow them unless the user says otherwise:`, "", instructions);
  }
  return lines.join("\n");
}

// A new conversation. Its system prompt includes the project's AGENTS.md, unless
// `instructions` is given (null for none).
export function createMessages({ instructions, ...env } = {}) {
  const cwd = env.cwd ?? process.cwd();
  return [
    {
      role: "system",
      content: systemPrompt({ ...env, cwd, instructions: instructions === undefined ? readProjectInstructions(cwd) : instructions }),
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

async function collectStream(stream, { onToken, onUsage, onActivity }) {
  let content = "";
  const toolCalls = [];

  for await (const chunk of stream) {
    // Token counts (and, from OpenRouter, the cost) arrive in a last chunk with no choices.
    if (chunk.usage) onUsage?.(chunk.usage);

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
  return message;
}

function logToolCall(name, args) {
  console.log(`\n[tool] ${name} ${JSON.stringify(args)}`);
}

function parseArguments(json) {
  const args = JSON.parse(json || "{}");
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("arguments must be a JSON object");
  return args;
}

// Resolves to { status: "ok" | "error" | "skipped" | "cancelled", content }, where content is
// what the model is told.
async function callTool(call, { confirmTool, onToolCall, onActivity, signal, changes }) {
  const cancelled = { status: "cancelled", content: CANCELLED };
  if (signal?.aborted) return cancelled;

  const { name } = call.function;
  let args;
  try {
    args = parseArguments(call.function.arguments);
  } catch (error) {
    // Announce the call anyway (with null args), so its error is not shown as the previous call's.
    onToolCall(name, null);
    return { status: "error", content: `error: invalid arguments: ${error.message}` };
  }

  try {
    onToolCall(name, args);
    // A call that would fail anyway, like an edit of text that isn't in the file, is reported
    // without asking the user to approve it.
    checkToolCall(name, args);

    const approved = await confirmTool(name, args, signal);
    // The task may have been cancelled while the user was being asked.
    if (signal?.aborted) return cancelled;
    if (!approved) return { status: "skipped", content: SKIPPED };

    // A cancelled shell command still returns its output so far, which the model should see.
    onActivity?.({ type: "running", name });
    const content = String(await runTool(name, args, { signal, changes }));
    return { status: signal?.aborted ? "cancelled" : "ok", content };
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

async function requestReply({ openai, model, messages, context, signal, onToken, onUsage, onActivity }) {
  onActivity?.({ type: "waiting" });
  const stream = await openai.chat.completions.create(
    { model, messages, tools, stream: true, stream_options: { include_usage: true } },
    { signal },
  );
  return collectStream(stream, {
    onToken,
    onActivity,
    onUsage: (usage) => {
      context?.measure(messages, usage);
      onUsage?.(usage);
    },
  });
}

// Leaves out the oldest messages of a summary request until it fits the context window, a whole
// turn at a time so that tool calls keep their results. Old tool output is trimmed first, and
// the summary from an earlier compaction is kept: it stands for everything before it.
function fitSummaryRequest(request, context) {
  if (!context.isFull(request)) return;
  context.trim(request);
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
 * `context`, a conversation too long to summarize whole is shortened first.
 */
export async function compactMessages({ openai, model = process.env.MODEL || DEFAULT_MODEL, messages, upTo = messages.length, context, signal, onToken, onUsage }) {
  if (upTo < 2) return 0;
  const request = [...messages.slice(0, upTo), { role: "user", content: SUMMARY_REQUEST }];
  if (context) fitSummaryRequest(request, context);

  // The tools are sent because the history has tool calls, but the model may not call them now.
  const stream = await openai.chat.completions.create(
    { model, messages: request, tools, tool_choice: "none", stream: true, stream_options: { include_usage: true } },
    { signal },
  );
  const reply = await collectStream(stream, { onToken, onUsage });
  signal?.throwIfAborted();

  const summary = reply.content?.trim();
  if (!summary) throw new Error("the model replied without a summary");
  messages.splice(1, upTo - 1, { role: "user", content: `${SUMMARY_NOTE}\n\n${summary}` });
  return upTo - 1;
}

// Before a request: when the conversation would fill too much of the context window, trims old
// tool output, and if that isn't enough, has the model summarize the tasks before this one.
// After a request that was too long anyway (`overflowed`), it also trims the newest output.
// Returns where the current task now starts in `messages`.
async function makeRoom({ taskStart, overflowed = false, ...options }) {
  const { context, messages, signal, onActivity, onContextChange } = options;
  if (!context?.isFull(messages)) return taskStart;

  const trimmed = context.trim(messages);
  if (trimmed) onContextChange?.({ type: "trimmed", count: trimmed });

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
    if (count) onContextChange?.({ type: "trimmed", count });
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
 * Aborting `signal` stops the turn and rejects with the signal's reason. Every tool call
 * already in `messages` still gets a result, so the conversation can continue afterwards.
 */
export async function agentTurn({
  task,
  openai,
  messages,
  confirmTool,
  onToolCall = logToolCall,
  onToolResult,
  onToken,
  onUsage,
  onActivity,
  onContextChange,
  changes,
  context,
  signal,
  model = process.env.MODEL || DEFAULT_MODEL,
  maxRounds = Number(process.env.MAX_TOOL_ROUNDS) || DEFAULT_MAX_TOOL_ROUNDS,
}) {
  let taskStart = messages.length;
  messages.push({ role: "user", content: task });
  const options = { openai, model, messages, context, signal, onToken, onUsage, onActivity, onContextChange };

  for (let i = 0; i < maxRounds; i++) {
    signal?.throwIfAborted();
    taskStart = await makeRoom({ ...options, taskStart });

    let message;
    try {
      message = await requestReply(options);
    } catch (error) {
      // Too long for the model after all: make room in the window the error states, and retry once.
      if (signal?.aborted || !context?.overflowed(error, messages)) throw error;
      taskStart = await makeRoom({ ...options, taskStart, overflowed: true });
      message = await requestReply(options);
    }
    // The SDK ends an aborted stream quietly instead of throwing; drop the partial reply.
    signal?.throwIfAborted();
    messages.push(message);

    if (!message.tool_calls) {
      return message.content ?? "";
    }

    for (const call of message.tool_calls) {
      const result = await callTool(call, { confirmTool, onToolCall, onActivity, signal, changes });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      onToolResult?.(call.function.name, result);
    }
  }

  signal?.throwIfAborted();
  const stopped = `Stopped after ${maxRounds} tool rounds. Say "continue" to keep going.`;
  onToken?.(stopped);
  return stopped;
}
