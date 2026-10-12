import { runTool, tools } from "./tools.mjs";

export function createMessages() {
  return [
    {
      role: "system",
      content:
        "You are a basic coding agent. Use tools to inspect and change project files. Store generated files/assets with write_asset unless the user is asking to modify the project source.",
    },
  ];
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

export async function agentTurn({ task, openai, messages, confirmTool, log = console.log, onToken }) {
  messages.push({ role: "user", content: task });

  for (let i = 0; i < 10; i++) {
    const stream = await openai.chat.completions.create({
      model: process.env.MODEL || "openai/gpt-4o-mini",
      messages,
      tools,
      stream: true,
    });

    const message = await collectStream(stream, onToken);
    messages.push(message);

    if (!message.tool_calls) {
      return message.content ?? "";
    }

    for (const call of message.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        log(`\n[tool] ${call.function.name} ${JSON.stringify(args)}`);

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

  const stopped = "Stopped after 10 tool rounds.";
  onToken?.(stopped);
  return stopped;
}
