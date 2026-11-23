import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { CANCELLED, PLAN_NOTE, agentTurn, compactMessages, createMessages, readProjectInstructions, readUserInstructions, systemPrompt } from "./agent-core.mjs";
import { FileChanges } from "./changes.mjs";
import { ContextWindow } from "./context.mjs";

// Like the real SDK, the fake stream just ends (no error) once its request signal is aborted.
// A { usage } item becomes the final chunk that reports token usage, and a { finish } item the
// chunk that says why the reply ended.
async function* streamOf(deltas, signal) {
  for (const delta of deltas) {
    if (signal?.aborted) return;
    if (delta.usage) yield { choices: [], usage: delta.usage };
    else if (delta.finish) yield { choices: [{ delta: {}, finish_reason: delta.finish }] };
    else yield { choices: [{ delta }] };
  }
}

// Answers each request with the next reply: a list of deltas, or an Error to throw.
// `bodies` keeps a copy of each request as it was sent.
function fakeOpenai(replies) {
  const fake = {
    requests: 0,
    models: [],
    bodies: [],
    chat: {
      completions: {
        create: async (body, options) => {
          fake.requests++;
          fake.models.push(body.model);
          fake.bodies.push(structuredClone(body));
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          return streamOf(reply, options?.signal);
        },
      },
    },
  };
  return fake;
}

// A conversation with one earlier task, which read a file with this output.
function afterReading(output) {
  return [
    ...createMessages({ instructions: null }),
    { role: "user", content: "read big.txt" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"big.txt"}' } }] },
    { role: "tool", tool_call_id: "1", content: output },
    { role: "assistant", content: "It is long." },
  ];
}

const REMOVED_OUTPUT = /^\[\d+ characters of old tool output removed/;

async function inTempDir(fn) {
  const originalCwd = cwd();
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  try {
    chdir(dir);
    return await fn(dir);
  } finally {
    chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function toolCallDelta(index, name, args) {
  return { tool_calls: [{ index, id: String(index + 1), function: { name, arguments: JSON.stringify(args) } }] };
}

describe("systemPrompt", () => {
  it("describes the project directory, shell and date", () => {
    // Half past midnight where the user is: in UTC, east of Greenwich, it is still January 1.
    const date = new Date(2026, 0, 2, 0, 30);

    const windows = systemPrompt({ cwd: "C:\\proj", platform: "win32", date });
    expect(windows).toContain("Project directory: C:\\proj");
    expect(windows).toContain("cmd.exe");
    expect(windows).toContain("2026-01-02");

    expect(systemPrompt({ cwd: "/proj", platform: "linux", date })).toContain("/bin/sh");
  });

  it("tells the model when it runs in the Docker sandbox", () => {
    const sandboxed = systemPrompt({ cwd: "/workspace", platform: "linux", sandbox: true });
    expect(sandboxed).toContain("You run in a Docker sandbox");
    expect(sandboxed).toContain("read-only");
    expect(createMessages({ cwd: "/workspace", platform: "linux", instructions: null, userInstructions: null, sandbox: true })[0].content).toBe(
      systemPrompt({ cwd: "/workspace", platform: "linux", sandbox: true }),
    );
    expect(systemPrompt({ cwd: "/proj", platform: "linux" })).not.toContain("sandbox");
  });

  it("starts the conversation with it", () => {
    expect(createMessages({ cwd: "/proj", platform: "linux", userInstructions: null })).toEqual([
      { role: "system", content: systemPrompt({ cwd: "/proj", platform: "linux" }) },
    ]);
  });

  it("includes the user's own AGENTS.md from ~/.phi-agent, before the project's", async () => {
    await inTempDir(async (home) => {
      expect(readUserInstructions(home)).toBe(null);
      mkdirSync(join(home, ".phi-agent"));
      writeFileSync(join(home, ".phi-agent", "AGENTS.md"), "Answer in British English.\n");
      expect(readUserInstructions(home)).toBe("Answer in British English.");

      const prompt = systemPrompt({ userInstructions: "Answer in British English.", instructions: "Use tabs." });
      expect(prompt).toContain("Instructions from the user's own AGENTS.md, for all their projects:\n\nAnswer in British English.");
      expect(prompt).toMatch(/where they disagree with the user's own, follow these:\n\nUse tabs\.$/);
      expect(systemPrompt({ instructions: "Use tabs." })).not.toContain("user's own");
    });
  });

  it("includes the project's AGENTS.md", async () => {
    await inTempDir(async (dir) => {
      expect(readProjectInstructions(dir)).toBe(null);
      writeFileSync("AGENTS.md", "  \n");
      expect(readProjectInstructions(dir)).toBe(null);

      writeFileSync("AGENTS.md", "# Notes\nRun npm test before finishing.\n");
      expect(readProjectInstructions(dir)).toBe("# Notes\nRun npm test before finishing.");

      const [system] = createMessages({ cwd: dir, userInstructions: null });
      expect(system.content).toContain("Instructions from the project's AGENTS.md");
      expect(system.content).toMatch(/Run npm test before finishing\.$/);
      expect(createMessages({ cwd: dir, instructions: null })[0].content).not.toContain("AGENTS.md");
    });
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
        onToolCall: () => {},
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
      agentTurn({ task: "test", openai, messages, confirmTool: async () => true, onToolCall: () => {} }),
    ).resolves.toBe("ok");

    const assistant = messages.find((m) => m.tool_calls);
    expect(assistant.tool_calls[0].function).toEqual({ name: "read_file", arguments: '{"path":"missing.txt"}' });
    expect(messages.find((m) => m.role === "tool").tool_call_id).toBe("1");
  });

  it("reports malformed tool arguments back to the model, and still announces the call", async () => {
    const openai = fakeOpenai([
      [
        { tool_calls: [{ index: 0, id: "1", function: { name: "read_file", arguments: "{bad" } }] },
        { tool_calls: [{ index: 1, id: "2", function: { name: "read_file", arguments: "null" } }] },
      ],
      [{ content: "recovered" }],
    ]);
    const messages = createMessages();
    const seen = [];

    await expect(
      agentTurn({ task: "test", openai, messages, confirmTool: async () => true, onToolCall: (name, args) => seen.push([name, args]) }),
    ).resolves.toBe("recovered");

    const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results[0]).toMatch(/^error: invalid arguments: /);
    expect(results[1]).toBe("error: invalid arguments: arguments must be a JSON object");
    expect(seen).toEqual([["read_file", null], ["read_file", null]]);
  });

  it("tells onToolResult how each tool call went", async () => {
    const openai = fakeOpenai([
      [
        toolCallDelta(0, "list_dir", {}),
        toolCallDelta(1, "write_file", { path: "src/never.txt", content: "x" }),
        toolCallDelta(2, "read_file", { path: "missing.txt" }),
      ],
      [{ content: "done" }],
    ]);
    const results = [];

    await agentTurn({
      task: "test",
      openai,
      messages: createMessages(),
      confirmTool: async (name) => name !== "write_file",
      onToolCall: () => {},
      onToolResult: (name, { status }) => results.push([name, status]),
    });

    expect(results).toEqual([
      ["list_dir", "ok"],
      ["write_file", "skipped"],
      ["read_file", "error"],
    ]);
  });

  it("requests the given model", async () => {
    const openai = fakeOpenai([[{ content: "hi" }]]);
    await agentTurn({ task: "test", openai, messages: createMessages(), confirmTool: async () => true, model: "test/model" });
    expect(openai.models).toEqual(["test/model"]);
  });

  it("asks for token usage and reports it for each request", async () => {
    const usage = { prompt_tokens: 1200, completion_tokens: 30, cost: 0.0004 };
    const openai = fakeOpenai([
      [toolCallDelta(0, "list_dir", {}), { usage }],
      [{ content: "done" }, { usage: { prompt_tokens: 1300, completion_tokens: 5 } }],
    ]);
    const usages = [];

    await agentTurn({
      task: "test",
      openai,
      messages: createMessages(),
      confirmTool: async () => true,
      onToolCall: () => {},
      onUsage: (u) => usages.push(u),
    });

    expect(openai.bodies[0].stream_options).toEqual({ include_usage: true });
    expect(usages).toEqual([usage, { prompt_tokens: 1300, completion_tokens: 5 }]);
  });

  it("records the file changes it makes", async () => {
    await inTempDir(async () => {
      const openai = fakeOpenai([[toolCallDelta(0, "write_file", { path: "src/a.txt", content: "a\n" })], [{ content: "done" }]]);
      const changes = new FileChanges();

      await agentTurn({ task: "test", openai, messages: createMessages(), confirmTool: async () => true, onToolCall: () => {}, changes });

      expect(changes.paths).toEqual(["src/a.txt"]);
    });
  });

  it("says when a reply stopped at the output limit, and doesn't run the call it cut off", async () => {
    await inTempDir(async () => {
      const openai = fakeOpenai([
        [toolCallDelta(0, "list_dir", {}), { tool_calls: [{ index: 1, id: "2", function: { name: "write_file", arguments: '{"path":"src/a.js","content":"le' } }] }, { finish: "length" }],
        [{ content: "Here is the start" }, { finish: "length" }],
      ]);
      const messages = createMessages();
      const notices = [];
      const results = [];

      const reply = await agentTurn({
        task: "write a.js",
        openai,
        messages,
        confirmTool: async () => true,
        onToolCall: () => {},
        onToolResult: (name, result) => results.push([name, result.status]),
        onNotice: (notice) => notices.push(notice),
      });

      expect(reply).toBe("Here is the start");
      expect(results).toEqual([
        ["list_dir", "ok"],
        ["write_file", "error"],
      ]);
      expect(messages.find((m) => m.tool_call_id === "2").content).toMatch(/^error: your reply reached the output limit before this call was complete, so it didn't run/);
      expect(existsSync("src/a.js")).toBe(false);
      expect(notices).toEqual([{ type: "cutOff" }]);
    });
  });

  it("doesn't run the last call of a cut-off reply even when its arguments look whole", async () => {
    await inTempDir(async () => {
      // The file's content may be cut short, though the JSON around it closed.
      const openai = fakeOpenai([[toolCallDelta(0, "write_file", { path: "src/a.js", content: "line 1\n" }), { finish: "length" }], [{ content: "ok" }]]);
      const messages = createMessages();
      await agentTurn({ task: "write a.js", openai, messages, confirmTool: async () => true, onToolCall: () => {} });
      expect(messages.find((m) => m.role === "tool").content).toMatch(/^error: your reply reached the output limit/);
      expect(existsSync("src/a.js")).toBe(false);
    });
  });

  it("rejects when the provider filtered the reply, leaving it out of the conversation", async () => {
    const openai = fakeOpenai([[{ content: "Sure" }, { finish: "content_filter" }]]);
    const messages = createMessages();
    await expect(agentTurn({ task: "test", openai, messages, confirmTool: async () => true, model: "test/model" })).rejects.toThrow(
      "test/model declined this request. Rephrase it, or try another model with /model.",
    );
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("agentTurn through OpenRouter", () => {
  it("marks Claude's prompt for caching, and keeps a conversation with one provider", async () => {
    const openai = fakeOpenai([[{ content: "hi" }], [{ content: "hi" }]]);
    const messages = createMessages({ instructions: null, userInstructions: null });
    const [system] = messages;

    await agentTurn({ task: "test", openai, messages, confirmTool: async () => true, model: "anthropic/claude-opus-4.5", sessionId: "s-1" });
    const [request] = openai.bodies;
    expect(request.cache_control).toEqual({ type: "ephemeral" });
    expect(request.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: system.content, cache_control: { type: "ephemeral" } }] });
    expect(request.session_id).toBe("s-1");
    // The conversation itself is left as it is.
    expect(messages[0]).toBe(system);

    // Other models cache by themselves.
    await agentTurn({ task: "test", openai, messages, confirmTool: async () => true, model: "openai/gpt-4o-mini" });
    expect(openai.bodies[1]).not.toHaveProperty("cache_control");
    expect(openai.bodies[1].messages[0]).toEqual(system);
  });

  it("leaves out the content blocks replies from the Claude API keep", async () => {
    const openai = fakeOpenai([[{ content: "ok" }]]);
    const messages = [
      ...createMessages({ instructions: null }),
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello.", claude: { content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Hello." }] } },
    ];
    await agentTurn({ task: "next", openai, messages, confirmTool: async () => true });
    expect(openai.bodies[0].messages[2]).toEqual({ role: "assistant", content: "Hello." });
    expect(messages[2].claude).toBeDefined();
  });
});

// The smallest valid PNG: a 1x1 transparent pixel.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PNG_PART = { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } };

describe("agentTurn plan mode", () => {
  it("asks for a plan, and runs only the tools that look around", async () => {
    await inTempDir(async () => {
      writeFileSync("notes.txt", "old\n");
      const openai = fakeOpenai([
        [toolCallDelta(0, "read_file", { path: "notes.txt" }), toolCallDelta(1, "write_file", { path: "notes.txt", content: "new\n" }), toolCallDelta(2, "shell", { cmd: "echo hi" })],
        [{ content: "Plan: change notes.txt." }],
      ]);
      const asked = [];
      const results = [];

      await agentTurn({
        task: "update the notes",
        planMode: true,
        openai,
        messages: createMessages({ instructions: null, userInstructions: null }),
        confirmTool: async (name) => asked.push(name) > 0,
        onToolCall: () => {},
        onToolResult: (name, { status, content }) => results.push([name, status, content]),
      });

      expect(openai.bodies[0].messages[1].content).toBe(`${PLAN_NOTE}\n\nupdate the notes`);
      expect(results.map(([name, status]) => [name, status])).toEqual([
        ["read_file", "ok"],
        ["write_file", "error"],
        ["shell", "error"],
      ]);
      expect(results[1][2]).toMatch(/^error: plan mode is on/);
      expect(asked).toEqual(["read_file"]); // the others were refused before anyone was asked
      expect(readFileSync("notes.txt", "utf8")).toBe("old\n");
    });
  });

  it("keeps a to-do list, which changes nothing", async () => {
    const todos = [{ content: "Change notes.txt", status: "pending" }];
    const openai = fakeOpenai([[toolCallDelta(0, "todo_write", { todos })], [{ content: "Plan: change notes.txt." }]]);
    const results = [];

    await agentTurn({
      task: "plan it",
      planMode: true,
      openai,
      messages: createMessages({ instructions: null, userInstructions: null }),
      confirmTool: async () => true,
      onToolCall: () => {},
      onToolResult: (name, { status, content }) => results.push([name, status, content]),
    });
    expect(results).toEqual([["todo_write", "ok", "The to-do list is updated: 0 of 1 done."]]);
  });
});

describe("agentTurn images", () => {
  it("shows the model an image it opens, after the results of all its tool calls", async () => {
    await inTempDir(async () => {
      writeFileSync("shot.png", PNG);
      const openai = fakeOpenai([[toolCallDelta(0, "view_image", { path: "shot.png" }), toolCallDelta(1, "list_dir", {})], [{ content: "A tiny image." }]]);
      const messages = createMessages({ instructions: null });

      await agentTurn({ task: "look at shot.png", openai, messages, confirmTool: async () => true, onToolCall: () => {} });

      expect(openai.bodies[0].tools.map((tool) => tool.function.name)).toContain("view_image");
      expect(openai.bodies[1].messages.slice(2).map(({ role, content }) => [role, content])).toEqual([
        ["assistant", null],
        ["tool", "shot.png follows as an image."],
        ["tool", "shot.png"],
        ["user", [{ type: "text", text: "shot.png:" }, PNG_PART]],
      ]);
    });
  });

  it("sends images the user attached with the task", async () => {
    const openai = fakeOpenai([[{ content: "I see it." }]]);
    await agentTurn({ task: "what's wrong here?", attachments: [PNG_PART], openai, messages: createMessages({ instructions: null }), confirmTool: async () => true });

    expect(openai.bodies[0].messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "what's wrong here?" }, PNG_PART] });
  });

  it("leaves images out for a model that can't see them", async () => {
    const openai = fakeOpenai([[{ content: "ok" }], [{ content: "Summary." }]]);
    const messages = [...createMessages({ instructions: null }), { role: "user", content: [{ type: "text", text: "see this" }, PNG_PART] }, { role: "assistant", content: "A pixel." }];

    await agentTurn({ task: "and now?", canSeeImages: false, openai, messages, confirmTool: async () => true });
    await compactMessages({ openai, messages, canSeeImages: false });

    for (const body of openai.bodies) {
      expect(body.tools.map((tool) => tool.function.name)).not.toContain("view_image");
      expect(JSON.stringify(body.messages)).not.toContain("image_url");
    }
    expect(openai.bodies[0].messages[1].content[1]).toEqual({ type: "text", text: "[an image was here, but this model can't see images]" });
    // The conversation itself keeps the image, for a model that can see it.
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(openai.bodies[1].messages)).toContain("see this");
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
        onToolCall: () => {},
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
      agentTurn({ task: "test", openai, messages, confirmTool, onToolCall: () => {}, signal: controller.signal }),
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
      agentTurn({ task: "test", openai, messages: createMessages(), confirmTool: async () => true, onToolCall: () => {}, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(openai.requests).toBe(0);
  });
});

describe("agentTurn round limit", () => {
  it("stops after maxRounds model requests with every tool call answered", async () => {
    const toolCall = (id) => [{ tool_calls: [{ index: 0, id, function: { name: "list_dir", arguments: "{}" } }] }];
    const openai = fakeOpenai([toolCall("1"), toolCall("2"), [{ content: "never requested" }]]);
    const messages = createMessages();
    const seen = [];

    const reply = await agentTurn({
      task: "test",
      openai,
      messages,
      confirmTool: async () => true,
      onToolCall: (name, args) => seen.push([name, args]),
      maxRounds: 2,
    });

    expect(reply).toMatch(/^Stopped after 2 tool rounds/);
    expect(openai.requests).toBe(2);
    expect(seen).toEqual([["list_dir", {}], ["list_dir", {}]]);
    expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "2" });
  });
});

describe("agentTurn checks and progress", () => {
  it("reports tool calls that would fail without asking to approve them", async () => {
    await inTempDir(async () => {
      writeFileSync("notes.txt", "hello\n");
      const openai = fakeOpenai([
        [
          toolCallDelta(0, "edit_file", { path: "notes.txt", old_string: "bye", new_string: "x" }),
          toolCallDelta(1, "write_file", { path: "new.txt", content: "x" }),
        ],
        [{ content: "done" }],
      ]);
      const messages = createMessages();
      const asked = [];
      const statuses = [];

      await agentTurn({
        task: "test",
        openai,
        messages,
        confirmTool: async (name) => asked.push(name) > 0,
        onToolCall: () => {},
        onToolResult: (name, { status }) => statuses.push(status),
      });

      expect(asked).toEqual([]);
      expect(statuses).toEqual(["error", "error"]);
      expect(messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
        "error: old_string not found, and nothing in the file is much like it.\nRead the file to see what it has now.",
        expect.stringMatching(/^error: New files can't be created at the project root/),
      ]);
    });
  });

  it("tells onActivity what it is waiting on", async () => {
    await inTempDir(async () => {
      const start = '{"path":"src\\/a b.txt",';
      const end = '"content":"hi"}';
      const openai = fakeOpenai([
        [
          { tool_calls: [{ index: 0, id: "1", function: { name: "write_file", arguments: "" } }] },
          { tool_calls: [{ index: 0, function: { arguments: start } }] },
          { tool_calls: [{ index: 0, function: { arguments: end } }] },
        ],
        [{ content: "done" }],
      ]);
      const activity = [];

      await agentTurn({
        task: "test",
        openai,
        messages: createMessages(),
        confirmTool: async () => true,
        onToolCall: () => {},
        onActivity: (a) => activity.push(a),
      });

      expect(activity).toEqual([
        { type: "waiting" },
        { type: "tool", name: "write_file", path: null, chars: 0 },
        { type: "tool", name: "write_file", path: "src/a b.txt", chars: start.length },
        { type: "tool", name: "write_file", path: "src/a b.txt", chars: start.length + end.length },
        { type: "running", name: "write_file", args: { path: "src/a b.txt", content: "hi" } },
        { type: "waiting" },
      ]);
    });
  });
});

describe("agentTurn context window", () => {
  // With an 8k window and no usage measured yet: full above about 18k characters.
  it("trims old tool output before a request that would fill the window", async () => {
    const messages = afterReading("x".repeat(30_000));
    const openai = fakeOpenai([[{ content: "ok" }]]);
    const changes = [];

    await agentTurn({
      task: "next",
      openai,
      messages,
      context: new ContextWindow({ limit: 8000 }),
      confirmTool: async () => true,
      onContextChange: (change) => changes.push(change),
    });

    const sent = openai.bodies[0].messages;
    expect(sent[3].content).toMatch(REMOVED_OUTPUT);
    expect(sent.at(-1)).toEqual({ role: "user", content: "next" });
    expect(changes).toEqual([{ type: "trimmed", count: 1 }]);
  });

  it("has the model summarize earlier tasks when trimming isn't enough", async () => {
    const messages = [
      ...createMessages({ instructions: null }),
      { role: "user", content: `here is the log:\n${"a".repeat(20_000)}` },
      { role: "assistant", content: "Noted." },
    ];
    const [system] = messages;
    const openai = fakeOpenai([[{ content: "The user pasted a long log." }], [{ content: "ok" }]]);
    const tokens = [];
    const changes = [];
    const activity = [];

    const reply = await agentTurn({
      task: "next",
      openai,
      messages,
      context: new ContextWindow({ limit: 8000 }),
      confirmTool: async () => true,
      onToken: (token) => tokens.push(token),
      onActivity: (a) => activity.push(a.type),
      onContextChange: (change) => changes.push(change),
    });

    const [summaryRequest, request] = openai.bodies;
    expect(summaryRequest.tool_choice).toBe("none");
    expect(summaryRequest.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(summaryRequest.messages.at(-1).content).toMatch(/^Summarize our conversation so far/);
    expect(request.messages).toEqual([
      system,
      { role: "user", content: expect.stringMatching(/^Summary of our earlier conversation [^\n]*\n\nThe user pasted a long log\.$/) },
      { role: "user", content: "next" },
    ]);
    expect(messages).toEqual([...request.messages, { role: "assistant", content: "ok" }]);
    expect(reply).toBe("ok");
    expect(tokens).toEqual(["ok"]); // the summary isn't shown as a reply
    expect(activity).toEqual(["compacting", "waiting"]);
    expect(changes).toEqual([{ type: "compacted", count: 2 }]);
  });

  it("never summarizes the current task, even when its later rounds fill the window", async () => {
    await inTempDir(async () => {
      writeFileSync("a.txt", "a".repeat(9000));
      writeFileSync("b.txt", "b".repeat(9000));
      const messages = [
        ...createMessages({ instructions: null }),
        { role: "user", content: `here is the log:\n${"l".repeat(20_000)}` },
        { role: "assistant", content: "Noted." },
      ];
      const openai = fakeOpenai([
        [{ content: "The user pasted a long log." }],
        [toolCallDelta(0, "read_file", { path: "a.txt" }), toolCallDelta(1, "read_file", { path: "b.txt" })],
        [{ content: "Both are long." }],
      ]);
      const changes = [];

      const reply = await agentTurn({
        task: "read a and b",
        openai,
        messages,
        context: new ContextWindow({ limit: 8000 }),
        confirmTool: async () => true,
        onToolCall: () => {},
        onContextChange: (change) => changes.push(change.type),
      });

      expect(reply).toBe("Both are long.");
      expect(openai.requests).toBe(3);
      expect(messages.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "tool", "tool", "assistant"]);
      expect(messages[2].content).toBe("read a and b");
      expect(changes).toEqual(["compacted"]);
    });
  });

  it("retries once in the window an error states when a request is too long", async () => {
    const messages = afterReading("x".repeat(30_000));
    const context = new ContextWindow(); // window not known: 128k assumed
    const openai = fakeOpenai([
      new Error("400 This endpoint's maximum context length is 8000 tokens. However, you requested about 12100 tokens"),
      [{ content: "ok" }],
    ]);
    const changes = [];

    const reply = await agentTurn({
      task: "next",
      openai,
      messages,
      context,
      confirmTool: async () => true,
      onContextChange: (change) => changes.push(change),
    });

    expect(reply).toBe("ok");
    expect(context.limit).toBe(8000);
    expect(openai.bodies[0].messages[3].content).toBe("x".repeat(30_000));
    expect(openai.bodies[1].messages[3].content).toMatch(REMOVED_OUTPUT);
    expect(changes).toEqual([{ type: "trimmed", count: 1 }]);
  });

  it("gives up after a second error, and doesn't retry other errors", async () => {
    const tooLong = () => new Error("400 This endpoint's maximum context length is 8000 tokens.");
    const twice = fakeOpenai([tooLong(), tooLong(), [{ content: "never" }]]);
    await expect(
      agentTurn({ task: "next", openai: twice, messages: afterReading("x".repeat(30_000)), context: new ContextWindow(), confirmTool: async () => true }),
    ).rejects.toThrow("maximum context length");
    expect(twice.requests).toBe(2);

    const other = fakeOpenai([new Error("401 No auth credentials found"), [{ content: "never" }]]);
    await expect(
      agentTurn({ task: "next", openai: other, messages: afterReading("x"), context: new ContextWindow(), confirmTool: async () => true }),
    ).rejects.toThrow("401");
    expect(other.requests).toBe(1);
  });
});

describe("compactMessages", () => {
  it("puts the model's summary in place of the conversation", async () => {
    const messages = afterReading("hello");
    const [system] = messages;
    const usage = { prompt_tokens: 900, completion_tokens: 20 };
    const openai = fakeOpenai([[{ content: "  The user had me read big.txt.  " }, { usage }]]);
    const usages = [];

    expect(await compactMessages({ openai, messages, onUsage: (u) => usages.push(u) })).toBe(4);
    expect(messages).toEqual([
      system,
      { role: "user", content: expect.stringMatching(/^Summary of our earlier conversation [^\n]*\n\nThe user had me read big\.txt\.$/) },
    ]);
    expect(openai.bodies[0].tool_choice).toBe("none");
    expect(usages).toEqual([usage]);
  });

  it("keeps an earlier summary when the conversation is too long to summarize whole", async () => {
    const messages = afterReading("hello");
    await compactMessages({ openai: fakeOpenai([[{ content: "We read big.txt." }]]), messages });
    const [system, firstSummary] = messages;
    messages.push(
      { role: "user", content: `first log: ${"a".repeat(14_000)}` },
      { role: "assistant", content: "Noted." },
      { role: "user", content: `second log: ${"b".repeat(14_000)}` },
      { role: "assistant", content: "Noted again." },
    );
    const openai = fakeOpenai([[{ content: "big.txt, then two logs." }]]);

    await compactMessages({ openai, messages, context: new ContextWindow({ limit: 8000 }) });

    // The oldest turn after the summary was left out of the request, not the summary itself.
    const sent = openai.bodies[0].messages;
    expect(sent.slice(0, 2)).toEqual([system, firstSummary]);
    expect(sent[2].content).toMatch(/^second log: /);
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "user"]);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toMatch(/big\.txt, then two logs\.$/);
  });

  it("leaves the conversation as it was when the model writes no summary", async () => {
    const messages = afterReading("hello");
    const before = structuredClone(messages);
    await expect(compactMessages({ openai: fakeOpenai([[{ content: " " }]]), messages })).rejects.toThrow("without a summary");
    expect(messages).toEqual(before);
  });
});
