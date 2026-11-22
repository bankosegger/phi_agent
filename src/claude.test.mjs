import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { agentTurn, compactMessages, createMessages } from "./agent-core.mjs";
import { ContextWindow } from "./context.mjs";
import {
  claudeCost,
  claudeRequest,
  dropThinking,
  fetchClaudeModels,
  isClaudeModel,
  streamClaudeReply,
  thinksAdaptively,
  toClaudeMessages,
} from "./claude.mjs";
import { toolsFor } from "./tools.mjs";

// --- A fake Claude API, behind the real SDK ---

// Text in two pieces, as a stream would bring it.
function pieces(text) {
  const half = Math.ceil(text.length / 2);
  return [text.slice(0, half), text.slice(half)].filter(Boolean);
}

/**
 * The stream events of a reply: `content` is a list of blocks like { type: "text", text },
 * { type: "thinking", signature }, { type: "tool_use", id, name, json } (the input as streamed)
 * and { type: "fallback", from, to, category }.
 */
function replyEvents({ content = [], stop = "end_turn", model = "claude-opus-5-5", usage = {}, category = null }) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input ?? 100, output_tokens: 1, cache_creation_input_tokens: usage.write ?? 0, cache_read_input_tokens: usage.read ?? 0 },
      },
    },
  ];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const text of pieces(block.text)) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      for (const json of pieces(block.json)) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } });
    } else if (block.type === "fallback") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "fallback", from: { model: block.from }, to: { model: block.to }, trigger: { type: "refusal", category: block.category ?? null } },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  const details = stop === "refusal" ? { type: "refusal", category, explanation: null } : null;
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, stop_details: details }, usage: { output_tokens: usage.output ?? 20 } });
  events.push({ type: "message_stop" });
  return events;
}

// A streamed response of these events, each `delayMs` after the last, that stops when aborted.
function sse(events, signal, delayMs = 0) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const event of events) {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal?.aborted) return controller.error(signal.reason);
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A Claude API client whose requests are answered in turn by `replies`: reply descriptions for
 * replyEvents (with `delayMs` to stream slowly, or `events` to send as they are), or
 * { status, error } for an API error. `requests` keeps each request's body and headers, and
 * GET /v1/models lists `models`.
 */
function fakeClaude(replies, { models = [] } = {}) {
  const fake = {
    requests: [],
    client: new Anthropic({
      apiKey: "test-key",
      baseURL: "https://claude.test",
      maxRetries: 0,
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname === "/v1/models") return json({ data: models, has_more: false, first_id: null, last_id: null });
        fake.requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
        const reply = replies.shift() ?? { content: [{ type: "text", text: "(no more replies)" }] };
        if (reply.error) return json({ type: "error", error: reply.error }, reply.status);
        return sse(reply.events ?? replyEvents(reply), init.signal, reply.delayMs);
      },
    }),
  };
  return fake;
}

// Streams one reply from the fake, collecting what the callbacks hear.
async function stream(replies, { request = claudeRequest({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }), signal } = {}) {
  const fake = fakeClaude(replies);
  const heard = { tokens: [], toolInput: [], usage: [], notices: [] };
  const result = await streamClaudeReply({
    client: fake.client,
    request,
    signal,
    onToken: (token) => heard.tokens.push(token),
    onToolInput: (call) => heard.toolInput.push(`${call.function.name} ${call.function.arguments}`),
    onUsage: (usage) => heard.usage.push(usage),
    onNotice: (notice) => heard.notices.push(notice),
  });
  return { ...result, heard, fake };
}

// --- Tests ---

describe("isClaudeModel and thinksAdaptively", () => {
  it("tell Claude API models from OpenRouter's, by their IDs", () => {
    expect(isClaudeModel("claude-opus-5-5")).toBe(true);
    expect(isClaudeModel("anthropic/claude-opus-4.5")).toBe(false);
    expect(isClaudeModel("openai/gpt-4o-mini")).toBe(false);
  });

  it("know which models take adaptive thinking, before the model list says", () => {
    for (const model of ["claude-opus-5-5", "claude-opus-4-6", "claude-sonnet-5", "claude-haiku-5-5", "claude-fable-5-2"]) {
      expect(thinksAdaptively(model), model).toBe(true);
    }
    for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-1-20250805", "claude-3-7-sonnet-20250219"]) {
      expect(thinksAdaptively(model), model).toBe(false);
    }
    expect(thinksAdaptively("claude-opus-5-5", { adaptiveThinking: false })).toBe(false);
  });
});

describe("toClaudeMessages", () => {
  it("turns the system prompt, tasks and images into Messages API content", () => {
    const { system, messages } = toClaudeMessages([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: [{ type: "text", text: "what's this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }] },
    ]);
    expect(system).toEqual([{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what's this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
        ],
      },
    ]);
  });

  it("sends tool calls as tool_use blocks, and their results in one user message, before anything else", () => {
    const { messages } = toClaudeMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "look at a and b" },
      {
        role: "assistant",
        content: "Reading both.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
          { id: "call_2", type: "function", function: { name: "view_image", arguments: "{not json" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents of a" },
      { role: "tool", tool_call_id: "call_2", content: "" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/gif;base64,R0lG" } }] },
      { role: "assistant", content: null },
      { role: "user", content: "(I undid your changes.)" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "look at a and b" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading both." },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "call_2", name: "view_image", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "contents of a" },
          { type: "tool_result", tool_use_id: "call_2" },
          { type: "image", source: { type: "base64", media_type: "image/gif", data: "R0lG" } },
          // The empty reply in between is left out, so the turns still alternate.
          { type: "text", text: "(I undid your changes.)" },
        ],
      },
    ]);
  });

  it("gives tool calls from other models IDs the API takes, the same for their results", () => {
    const call = (id) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "git", arguments: "{}" } }] });
    const { messages } = toClaudeMessages([
      { role: "user", content: "go" },
      call("functions.git:0"),
      { role: "tool", tool_call_id: "functions.git:0", content: "first" },
      call("functions.git:0"),
      { role: "tool", tool_call_id: "functions.git:0", content: "second" },
    ]);
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content[0].id)).toEqual(["functions_git_0", "functions_git_0_2"]);
    expect(messages.filter((m) => m.role === "user").slice(1).map((m) => m.content[0].tool_use_id)).toEqual(["functions_git_0", "functions_git_0_2"]);
  });

  it("sends Claude's own replies back as they came, thinking and all", () => {
    const blocks = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a" } },
    ];
    const { messages } = toClaudeMessages([
      { role: "user", content: "read a" },
      { role: "assistant", content: "Reading it.", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }], claude: { content: blocks } },
      { role: "tool", tool_call_id: "toolu_1", content: "a" },
    ]);
    expect(messages[1]).toEqual({ role: "assistant", content: blocks });
    expect(messages[2].content[0].tool_use_id).toBe("toolu_1");
  });
});

describe("claudeRequest", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];

  it("asks for a streamed reply with adaptive thinking, caching, and the agent's tools", () => {
    const request = claudeRequest({ model: "claude-opus-5-5", messages, tools: toolsFor() });
    expect(request).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 64_000,
      betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    });
    expect(request.tools.map((tool) => tool.name)).toEqual(toolsFor().map((tool) => tool.function.name));
    expect(request.tools[0]).toEqual({
      name: "shell",
      description: toolsFor()[0].function.description,
      input_schema: toolsFor()[0].function.parameters,
      eager_input_streaming: true,
    });
    expect(request).not.toHaveProperty("tool_choice");
    expect(request).not.toHaveProperty("output_config");
  });

  it("follows what the model list says, and the effort asked for", () => {
    const request = claudeRequest({ model: "claude-opus-5-5", messages, toolChoice: "none", about: { maxOutput: 32_000 }, effort: "high" });
    expect(request.max_tokens).toBe(32_000);
    expect(request.tool_choice).toEqual({ type: "none" });
    expect(request.output_config).toEqual({ effort: "high" });

    // Haiku 4.5 takes neither adaptive thinking nor effort; a model the list says can't do xhigh
    // gets its default.
    const older = claudeRequest({ model: "claude-haiku-4-5", messages, effort: "high" });
    expect(older).not.toHaveProperty("thinking");
    expect(older).not.toHaveProperty("output_config");
    const about = { effort: { supported: true, high: { supported: true }, xhigh: { supported: false } } };
    expect(claudeRequest({ model: "claude-opus-4-6", messages, about, effort: "xhigh" })).not.toHaveProperty("output_config");
  });
});

describe("streamClaudeReply", () => {
  it("streams the text and reports the usage, with an estimated cost", async () => {
    const { message, stop, heard, fake } = await stream([{ content: [{ type: "text", text: "Hello there" }], usage: { input: 10, read: 1000, write: 200, output: 50 } }]);
    expect(heard.tokens.join("")).toBe("Hello there");
    expect(message).toEqual({ role: "assistant", content: "Hello there" });
    expect(stop).toBe("done");
    expect(heard.usage).toEqual([
      {
        prompt_tokens: 1210,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 200 },
        cost: (10 * 4 + 200 * 5 + 1000 * 0.2 + 50 * 20) / 1e6,
        cost_estimated: true,
      },
    ]);
    // The beta features go in the header.
    expect(fake.requests[0].headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01,thinking-binding-controls-2026-08-01");
    expect(fake.requests[0].body).not.toHaveProperty("betas");
  });

  it("keeps Claude's thinking with the reply, and tool call arguments as Claude wrote them", async () => {
    const { message, stop, heard } = await stream([
      {
        content: [
          { type: "thinking", signature: "sig-1" },
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "toolu_1", name: "read_file", json: '{"path": "src/a.js"}' },
        ],
        stop: "tool_use",
      },
    ]);
    expect(stop).toBe("done");
    expect(message.content).toBe("Let me look.");
    expect(message.tool_calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: '{"path": "src/a.js"}' } }]);
    expect(message.claude.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/a.js" } },
    ]);
    expect(heard.toolInput).toEqual(["read_file ", 'read_file {"path": "', 'read_file {"path": "src/a.js"}']);
  });

  it("doesn't keep a reply's thinking when there is nothing to send back with it", async () => {
    const { message } = await stream([{ content: [{ type: "thinking", signature: "alone" }] }]);
    expect(message).toEqual({ role: "assistant", content: null });
  });

  it("starts a new paragraph for each text block, but not where a fallback model carries on", async () => {
    const { message, heard } = await stream([
      {
        content: [
          { type: "text", text: "First." },
          { type: "thinking", signature: "s" },
          { type: "text", text: "Second, and" },
          { type: "fallback", from: "claude-opus-5-5", to: "claude-opus-5", category: "cyber" },
          { type: "text", text: " the rest." },
        ],
      },
    ]);
    expect(message.content).toBe("First.\n\nSecond, and the rest.");
    expect(heard.tokens.join("")).toBe(message.content);
    expect(heard.notices).toEqual([{ type: "fallback", from: "claude-opus-5-5", to: "claude-opus-5", category: "cyber" }]);
  });

  it("leaves out what a declining model thought and called before the fallback model took over", async () => {
    const { message, heard } = await stream([
      {
        model: "claude-opus-5-5",
        content: [
          { type: "thinking", signature: "declined" },
          { type: "text", text: "I'll run" },
          { type: "tool_use", id: "toolu_1", name: "shell", json: '{"cmd":"nmap' },
          { type: "fallback", from: "claude-opus-5-5", to: "claude-opus-5" },
          { type: "thinking", signature: "kept" },
          { type: "tool_use", id: "toolu_2", name: "read_file", json: '{"path":"a"}' },
        ],
        stop: "tool_use",
        usage: { input: 1000, output: 100 },
      },
    ]);
    expect(message.tool_calls.map((call) => call.id)).toEqual(["toolu_2"]);
    expect(message.claude.content.map((block) => block.signature ?? block.type)).toEqual(["text", "fallback", "kept", "tool_use"]);
    // Priced as the model that served it.
    expect(heard.usage[0].cost).toBeCloseTo((1000 * 5 + 100 * 25) / 1e6, 10);
  });

  it("says when the model declined, and why", async () => {
    const { message, stop, refusal } = await stream([{ content: [{ type: "text", text: "Sure, here" }], stop: "refusal", category: "cyber" }]);
    expect(stop).toBe("refusal");
    expect(refusal).toEqual({ category: "cyber" });
    expect(message).toEqual({ role: "assistant", content: "Sure, here" });
  });

  it("says when the reply was cut off, keeping the cut-off call's arguments as they are", async () => {
    const { message, stop } = await stream([
      { content: [{ type: "tool_use", id: "toolu_1", name: "write_file", json: '{"path":"a.js","content":"line 1\\nline' }], stop: "max_tokens" },
    ]);
    expect(stop).toBe("cut_off");
    // Not the SDK's guess at the whole input, which would write half the file.
    expect(message.tool_calls[0].function.arguments).toBe('{"path":"a.js","content":"line 1\\nline');
  });

  it("asks again when the SDK can't read a tool call's input, but not after an API error", async () => {
    const garbled = { content: [{ type: "tool_use", id: "toolu_1", name: "read_file", json: '{"path": }' }], stop: "tool_use" };
    const { message, heard, fake } = await stream([garbled, { content: [{ type: "text", text: "ok" }] }]);
    expect(message.content).toBe("ok");
    expect(fake.requests).toHaveLength(2);
    expect(heard.notices.map((notice) => notice.type)).toEqual(["retry"]);

    const failing = fakeClaude([{ status: 400, error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } }]);
    const request = claudeRequest({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] });
    await expect(streamClaudeReply({ client: failing.client, request })).rejects.toThrow(/prompt is too long.*> 200000 maximum/);
    expect(failing.requests).toHaveLength(1);
  });

  it("stops when cancelled, rejecting with the signal's reason", async () => {
    const controller = new AbortController();
    const tokens = [];
    const fake = fakeClaude([{ content: [{ type: "text", text: "a long reply that streams slowly" }], delayMs: 30 }]);
    const pending = streamClaudeReply({
      client: fake.client,
      request: claudeRequest({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
      onToken: (token) => {
        tokens.push(token);
        controller.abort(new Error("cancelled by user"));
      },
    });
    await expect(pending).rejects.toThrow("cancelled by user");
    expect(tokens).toHaveLength(1);
  });
});

describe("fetchClaudeModels", () => {
  it("reads the context window, output limit and capabilities of each model", async () => {
    const capabilities = { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { supported: true } };
    const fake = fakeClaude([], {
      models: [
        { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities },
        { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000, max_tokens: 64_000, capabilities: null },
      ],
    });
    const models = await fetchClaudeModels(fake.client);
    expect(models.get("claude-opus-5-5")).toEqual({
      contextLength: 1_000_000,
      maxOutput: 128_000,
      images: true,
      tools: true,
      adaptiveThinking: true,
      effort: { supported: true },
    });
    expect(models.get("claude-haiku-4-5-20251001")).toMatchObject({ contextLength: 200_000, images: null, adaptiveThinking: null });
  });
});

describe("claudeCost", () => {
  it("estimates a request's cost from list prices", () => {
    const usage = { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(claudeCost("claude-opus-5-5", usage)).toBeCloseTo(4 + 5 + 0.2 + 20, 10);
    expect(claudeCost("claude-haiku-4-5-20251001", { input_tokens: 1_000_000 })).toBeCloseTo(1, 10);
    // Claude Haiku 5.5 costs more for a prompt over 100k tokens.
    expect(claudeCost("claude-haiku-5-5", { input_tokens: 100_000 })).toBeCloseTo(0.01, 10);
    expect(claudeCost("claude-haiku-5-5", { input_tokens: 100_001 })).toBeCloseTo((100_001 * 0.5) / 1e6, 10);
    expect(claudeCost("claude-new-model", usage)).toBe(null);
  });
});

describe("agentTurn with a Claude model", () => {
  const turn = (fake, messages, options = {}) =>
    agentTurn({
      task: "list the project",
      claude: fake.client,
      model: "claude-opus-5-5",
      messages,
      confirmTool: async () => true,
      onToolCall: () => {},
      ...options,
    });

  it("runs a task, sending Claude's thinking back with the tool results", async () => {
    const fake = fakeClaude([
      { content: [{ type: "thinking", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", name: "list_dir", json: "{}" }], stop: "tool_use" },
      { content: [{ type: "thinking", signature: "sig-2" }, { type: "text", text: "It has a src folder." }] },
    ]);
    const messages = createMessages({ instructions: null, userInstructions: null });
    const activity = [];
    const usages = [];

    const reply = await turn(fake, messages, { onActivity: (a) => activity.push(a.type), onUsage: (u) => usages.push(u) });

    expect(reply).toBe("It has a src folder.");
    const [first, second] = fake.requests.map((request) => request.body);
    expect(first.system[0].text).toBe(messages[0].content);
    expect(second.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "list_dir", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: messages[3].content }] },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(messages[4]).toEqual({ role: "assistant", content: "It has a src folder.", claude: { content: expect.any(Array) } });
    // The tool call as it starts, and as each of the two pieces of its input comes.
    expect(activity).toEqual(["waiting", "tool", "tool", "tool", "running", "waiting"]);
    expect(usages).toHaveLength(2);
  });

  it("forgets Claude's thinking once old tool output is trimmed, as it no longer matches", async () => {
    const thought = { content: [{ type: "thinking", thinking: "", signature: "old" }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "big.txt" } }] };
    const messages = [
      ...createMessages({ instructions: null }),
      { role: "user", content: "read big.txt" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: '{"path":"big.txt"}' } }], claude: thought },
      { role: "tool", tool_call_id: "toolu_1", content: "x".repeat(30_000) },
      { role: "assistant", content: "It is long." },
    ];
    const fake = fakeClaude([{ content: [{ type: "text", text: "ok" }] }]);

    await turn(fake, messages, { task: "next", context: new ContextWindow({ limit: 8000 }) });

    expect(fake.requests[0].body.messages[1].content).toEqual([{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "big.txt" } }]);
    expect(messages[2]).not.toHaveProperty("claude");
  });

  it("forgets the thinking of the current task when the tasks before it are summarized", async () => {
    const messages = [
      ...createMessages({ instructions: null }),
      { role: "user", content: `here is the log:\n${"a".repeat(20_000)}` },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "list the project" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "list_dir", arguments: "{}" } }], claude: { content: [] } },
      { role: "tool", tool_call_id: "toolu_1", content: "src/" },
    ];
    const fake = fakeClaude([{ content: [{ type: "text", text: "A long log was pasted." }] }]);

    expect(await compactMessages({ claude: fake.client, model: "claude-opus-5-5", messages, upTo: 3 })).toBe(2);
    expect(fake.requests[0].body.tool_choice).toEqual({ type: "none" });
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "tool"]);
    expect(messages[3]).not.toHaveProperty("claude");
  });

  it("forgets Claude's thinking when shortening a conversation to summarize it trims it", async () => {
    const thought = { content: [{ type: "thinking", thinking: "", signature: "old" }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "big.txt" } }] };
    const messages = [
      ...createMessages({ instructions: null }),
      { role: "user", content: "read big.txt" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: '{"path":"big.txt"}' } }], claude: thought },
      { role: "tool", tool_call_id: "toolu_1", content: "x".repeat(30_000) },
      { role: "assistant", content: "It is long." },
    ];
    // The summary fails, but the conversation was trimmed on the way, so its thinking goes.
    const fake = fakeClaude([{ content: [{ type: "text", text: " " }] }]);
    await expect(compactMessages({ claude: fake.client, model: "claude-opus-5-5", messages, context: new ContextWindow({ limit: 8000 }) })).rejects.toThrow(
      "without a summary",
    );
    expect(messages[3].content).toMatch(/characters of old tool output removed/);
    expect(messages[2]).not.toHaveProperty("claude");
  });

  it("leaves the conversation as it was when Claude declines to summarize it", async () => {
    const messages = [...createMessages({ instructions: null }), { role: "user", content: "hi" }, { role: "assistant", content: "Hello." }];
    const before = structuredClone(messages);
    const fake = fakeClaude([{ content: [{ type: "text", text: "Summary:" }], stop: "refusal" }]);
    await expect(compactMessages({ claude: fake.client, model: "claude-opus-5-5", messages })).rejects.toThrow("claude-opus-5-5 declined this request.");
    expect(messages).toEqual(before);
  });

  it("rejects when Claude declines, leaving its reply out of the conversation", async () => {
    const fake = fakeClaude([{ content: [{ type: "text", text: "Sure" }], stop: "refusal", category: "cyber" }]);
    const messages = createMessages({ instructions: null });
    await expect(turn(fake, messages)).rejects.toThrow("claude-opus-5-5 declined this request (cyber). Rephrase it, or try another model with /model.");
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("needs the Claude client for a Claude model", async () => {
    await expect(turn({ client: undefined }, createMessages({ instructions: null }))).rejects.toThrow(
      "claude-opus-5-5 is a Claude API model, which needs ANTHROPIC_API_KEY to be set.",
    );
  });
});

describe("dropThinking", () => {
  it("forgets the content blocks replies came with", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "a", claude: { content: [] } },
      { role: "assistant", content: "b" },
    ];
    expect(dropThinking(messages)).toBe(1);
    expect(messages[1]).toEqual({ role: "assistant", content: "a" });
  });
});
