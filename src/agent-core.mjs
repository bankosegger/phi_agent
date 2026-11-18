import { runTool, tools } from "./tools.mjs";

const DEFAULT_MAX_TOOL_ROUNDS = 25;
export const CANCELLED = "cancelled by user";

export function systemPrompt({ cwd = process.cwd(), platform = process.platform, date = new Date() } = {}) {
  const shell = platform === "win32" ? "cmd.exe" : "/bin/sh";

  return [
    "You are a basic coding agent. Use tools to inspect and change project files.",
    "Prefer read_file, list_dir, grep and git over shell for reading the project. Use edit_file for small changes to existing files.",
    "Root-level writes are blocked: put project files in a subfolder like src/. Store generated files/assets with write_asset unless the user is asking to modify the project source.",
    "",
    `Project directory: ${cwd}`,
    `Platform: ${platform}; the shell tool runs commands with ${shell}.`,
    `Today's date: ${date.toISOString().slice(0, 10)}`,
  ].join("\n");
}

export function createMessages(env) {
  return [{ role: "system", content: systemPrompt(env) }];
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

function logToolCall(name, args) {
  console.log(`\n[tool] ${name} ${JSON.stringify(args)}`);
}

async function callTool(call, { confirmTool, onToolCall, signal }) {
  if (signal?.aborted) return CANCELLED;

  try {
    const args = JSON.parse(call.function.arguments || "{}");
    onToolCall(call.function.name, args);

    const approved = await confirmTool(call.function.name, args, signal);
    // The task may have been cancelled while the user was being asked.
    if (signal?.aborted) return CANCELLED;
    if (!approved) return "skipped by user";
    return String(await runTool(call.function.name, args, { signal }));
  } catch (error) {
    // An abort while confirming rejects the prompt; report it as a cancel, not a tool error.
    return signal?.aborted ? CANCELLED : `error: ${error.message}`;
  }
}

/**
 * Runs one user task until the model replies without tool calls, or for at most `maxRounds`
 * model requests (MAX_TOOL_ROUNDS in the environment, default 25).
 * `onToolCall(name, args)` is told about each tool call before it is confirmed and run.
 * Aborting `signal` stops the turn and rejects with the signal's reason. Every tool call
 * already in `messages` still gets a result, so the conversation can continue afterwards.
 */
export async function agentTurn({
  task,
  openai,
  messages,
  confirmTool,
  onToolCall = logToolCall,
  onToken,
  signal,
  maxRounds = Number(process.env.MAX_TOOL_ROUNDS) || DEFAULT_MAX_TOOL_ROUNDS,
}) {
  messages.push({ role: "user", content: task });

  for (let i = 0; i < maxRounds; i++) {
    signal?.throwIfAborted();

    const stream = await openai.chat.completions.create(
      { model: process.env.MODEL || "openai/gpt-4o-mini", messages, tools, stream: true },
      { signal },
    );

    const message = await collectStream(stream, onToken);
    // The SDK ends an aborted stream quietly instead of throwing; drop the partial reply.
    signal?.throwIfAborted();
    messages.push(message);

    if (!message.tool_calls) {
      return message.content ?? "";
    }

    for (const call of message.tool_calls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await callTool(call, { confirmTool, onToolCall, signal }) });
    }
  }

  signal?.throwIfAborted();
  const stopped = `Stopped after ${maxRounds} tool rounds. Say "continue" to keep going.`;
  onToken?.(stopped);
  return stopped;
}
