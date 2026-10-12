import { describe, expect, it } from "vitest";
import { createMessages, agentTurn } from "./agent-core.mjs";

async function* streamOf(deltas) {
  for (const delta of deltas) yield { choices: [{ delta }] };
}

function fakeOpenai(replies) {
  return { chat: { completions: { create: async () => streamOf(replies.shift()) } } };
}

describe("agentTurn", () => {
  it("returns the final model message and streams tokens", async () => {
    const openai = fakeOpenai([[{ content: "do" }, { content: "ne" }]]);
    const tokens = [];

    await expect(
      agentTurn({
        task: "test",
        openai,
        messages: createMessages(),
        confirmTool: async () => true,
        log: () => {},
        onToken: (token) => tokens.push(token),
      }),
    ).resolves.toBe("done");
    expect(tokens).toEqual(["do", "ne"]);
  });

  it("reassembles tool calls split across stream chunks", async () => {
    const openai = fakeOpenai([
      [
        { tool_calls: [{ index: 0, id: "1", function: { name: "read_file", arguments: '{"pa' } }] },
        { tool_calls: [{ index: 0, function: { arguments: 'th":"missing.txt"}' } }] },
      ],
      [{ content: "ok" }],
    ]);
    const messages = createMessages();

    await expect(
      agentTurn({ task: "test", openai, messages, confirmTool: async () => true, log: () => {} }),
    ).resolves.toBe("ok");

    const assistant = messages.find((m) => m.tool_calls);
    expect(assistant.tool_calls[0].function).toEqual({ name: "read_file", arguments: '{"path":"missing.txt"}' });
    expect(messages.find((m) => m.role === "tool").tool_call_id).toBe("1");
  });

  it("reports malformed tool arguments back to the model", async () => {
    const openai = fakeOpenai([
      [{ tool_calls: [{ index: 0, id: "1", function: { name: "read_file", arguments: "{bad" } }] }],
      [{ content: "recovered" }],
    ]);
    const messages = createMessages();

    await expect(
      agentTurn({ task: "test", openai, messages, confirmTool: async () => true, log: () => {} }),
    ).resolves.toBe("recovered");
    expect(messages.find((m) => m.role === "tool").content).toMatch(/^error: /);
  });
});
