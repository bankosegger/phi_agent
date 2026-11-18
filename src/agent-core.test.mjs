import { describe, expect, it } from "vitest";
import { CANCELLED, createMessages, agentTurn, systemPrompt } from "./agent-core.mjs";

// Like the real SDK, the fake stream just ends (no error) once its request signal is aborted.
async function* streamOf(deltas, signal) {
  for (const delta of deltas) {
    if (signal?.aborted) return;
    yield { choices: [{ delta }] };
  }
}

function fakeOpenai(replies) {
  const fake = {
    requests: 0,
    chat: {
      completions: {
        create: async (body, options) => {
          fake.requests++;
          return streamOf(replies.shift(), options?.signal);
        },
      },
    },
  };
  return fake;
}

describe("systemPrompt", () => {
  it("describes the project directory, shell and date", () => {
    const date = new Date("2026-01-02T03:00:00Z");

    const windows = systemPrompt({ cwd: "C:\\proj", platform: "win32", date });
    expect(windows).toContain("Project directory: C:\\proj");
    expect(windows).toContain("cmd.exe");
    expect(windows).toContain("2026-01-02");

    expect(systemPrompt({ cwd: "/proj", platform: "linux", date })).toContain("/bin/sh");
  });

  it("starts the conversation with it", () => {
    expect(createMessages({ cwd: "/proj", platform: "linux" })).toEqual([
      { role: "system", content: systemPrompt({ cwd: "/proj", platform: "linux" }) },
    ]);
  });
});

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

describe("agentTurn cancellation", () => {
  it("stops a streaming reply without saving the partial message", async () => {
    const controller = new AbortController();
    const openai = fakeOpenai([[{ content: "par" }, { content: "tial" }]]);
    const messages = createMessages();

    await expect(
      agentTurn({
        task: "test",
        openai,
        messages,
        confirmTool: async () => true,
        log: () => {},
        onToken: () => controller.abort(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("answers every pending tool call when cancelled during confirmation", async () => {
    const controller = new AbortController();
    const openai = fakeOpenai([
      [
        { tool_calls: [{ index: 0, id: "1", function: { name: "shell", arguments: '{"cmd":"echo 1"}' } }] },
        { tool_calls: [{ index: 1, id: "2", function: { name: "shell", arguments: '{"cmd":"echo 2"}' } }] },
      ],
      [{ content: "never requested" }],
    ]);
    const messages = createMessages();
    const confirmTool = async () => {
      controller.abort();
      return true;
    };

    await expect(
      agentTurn({ task: "test", openai, messages, confirmTool, log: () => {}, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);

    // The conversation stays valid for the next request: each tool call has a result.
    expect(messages.filter((m) => m.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "1", content: CANCELLED },
      { role: "tool", tool_call_id: "2", content: CANCELLED },
    ]);
    expect(openai.requests).toBe(1);
  });

  it("does not start a request once already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const openai = fakeOpenai([[{ content: "never" }]]);

    await expect(
      agentTurn({ task: "test", openai, messages: createMessages(), confirmTool: async () => true, log: () => {}, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(openai.requests).toBe(0);
  });
});
