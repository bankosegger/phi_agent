import { describe, expect, it } from "vitest";
import { ContextWindow, fetchModels, isOverflowError, modelInfo } from "./context.mjs";

const system = { role: "system", content: "You are a coding agent." };

function call(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const REMOVED_OUTPUT = /^\[\d+ characters of old tool output removed to save context space; run the tool again if you need it\]$/;

describe("ContextWindow", () => {
  it("learns from token usage how full the window is and how long a token is", () => {
    const context = new ContextWindow({ limit: 100_000 });
    const messages = [system, { role: "user", content: "x".repeat(40_000) }];
    expect(context.used).toBe(null);
    const guess = context.estimate(messages); // 3 characters per token until measured

    context.measure(messages, { prompt_tokens: 10_000, completion_tokens: 50 });
    expect(context.used).toBe(10_050);
    expect(guess).toBeGreaterThan(14_000);
    expect(Math.abs(context.estimate(messages) - 10_000)).toBeLessThanOrEqual(1);
    expect(context.isFull(messages)).toBe(false);

    messages.push({ role: "user", content: "x".repeat(400_000) });
    expect(context.isFull(messages)).toBe(true); // over 75% of the window

    context.reset();
    expect(context.used).toBe(null);
  });

  it("trims old tool output and arguments, oldest first, until half the window is free", () => {
    // 3 characters per token: full above 22.5k characters, trimmed down to 15k.
    const context = new ContextWindow({ limit: 10_000 });
    const messages = [
      system,
      { role: "user", content: "write a and read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("1", "write_file", { path: "src/a.txt", content: "a".repeat(6000) }), call("2", "read_file", { path: "src/a.txt" })],
      },
      { role: "tool", tool_call_id: "1", content: "ok" },
      { role: "tool", tool_call_id: "2", content: "b".repeat(6000) },
      { role: "assistant", content: null, tool_calls: [call("3", "read_file", { path: "big.txt" })] },
      { role: "tool", tool_call_id: "3", content: "c".repeat(6000) }, // not seen by the model yet
    ];
    expect(context.isFull(messages)).toBe(true);

    expect(context.trim(messages)).toBe(2);
    expect(JSON.parse(messages[2].tool_calls[0].function.arguments)).toEqual({
      path: "src/a.txt",
      content: "[6000 characters removed to save context space]",
    });
    expect(messages[2].tool_calls[1].function.arguments).toBe('{"path":"src/a.txt"}');
    expect(messages[3].content).toBe("ok");
    expect(messages[4].content).toMatch(REMOVED_OUTPUT);
    expect(messages[6].content).toBe("c".repeat(6000));
    expect(context.isFull(messages)).toBe(false);
    expect(context.trim(messages)).toBe(0);

    // When even that is too much, the newest output can go too.
    context.limit = 3000;
    expect(context.trim(messages, { keepNewest: false })).toBe(1);
    expect(messages[6].content).toMatch(REMOVED_OUTPUT);
  });

  it("counts an image as a fixed size, and removes old images when trimming", () => {
    const context = new ContextWindow({ limit: 10_000 });
    const image = (bytes) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(bytes)}` } });
    const messages = [
      system,
      { role: "user", content: [{ type: "text", text: "what is wrong here?" }, image(3_000_000)] },
      { role: "assistant", content: "The button overlaps the title." },
      { role: "user", content: [{ type: "text", text: "and here?" }, image(10), image(10)] },
    ];
    // A 3 MB image counts the same as a tiny one: about 5000 characters.
    const estimate = context.estimate(messages);
    const withTinyImages = structuredClone(messages);
    withTinyImages[1].content[1] = image(10);
    expect(context.estimate(withTinyImages)).toBe(estimate);
    withTinyImages[1].content.pop();
    const perImage = estimate - context.estimate(withTinyImages); // in tokens, at 3 characters each
    expect(perImage).toBeGreaterThanOrEqual(5000 / 3);
    expect(perImage).toBeLessThan(5100 / 3);

    context.limit = 6000;
    expect(context.trim(messages)).toBe(1);
    expect(messages[1].content).toEqual([
      { type: "text", text: "what is wrong here?" },
      { type: "text", text: "[image removed to save context space; look at it again if you need it]" },
    ]);
    // The newest images, which the model hasn't seen yet, stay.
    expect(messages[3].content.filter((part) => part.type === "image_url")).toHaveLength(2);
  });

  it("stops trimming once there is room, keeping later output", () => {
    const context = new ContextWindow({ limit: 10_000 });
    const messages = [
      system,
      { role: "user", content: "read a and b" },
      { role: "assistant", content: null, tool_calls: [call("1", "read_file", { path: "a" }), call("2", "read_file", { path: "b" })] },
      { role: "tool", tool_call_id: "1", content: "a".repeat(16_000) },
      { role: "tool", tool_call_id: "2", content: "b".repeat(2000) },
      { role: "assistant", content: "Read both." },
      { role: "user", content: "next" },
    ];
    expect(context.isFull(messages)).toBe(true);
    expect(context.trim(messages)).toBe(1);
    expect(messages[3].content).toMatch(REMOVED_OUTPUT);
    expect(messages[4].content).toBe("b".repeat(2000));
  });

  it("replaces arguments that aren't valid JSON", () => {
    const context = new ContextWindow({ limit: 4000 });
    const messages = [
      system,
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: `{"content":"${"x".repeat(9000)}` } }] },
      { role: "tool", tool_call_id: "1", content: "error: invalid arguments: Unterminated string in JSON" },
      { role: "assistant", content: "Sorry." },
    ];
    context.trim(messages);
    expect(messages[2].tool_calls[0].function.arguments).toBe("{}");
  });

  it("doesn't count the content blocks of Claude API replies, which repeat their text and calls", () => {
    const context = new ContextWindow();
    const reply = { role: "assistant", content: "x".repeat(3000) };
    const withBlocks = { ...reply, claude: { content: [{ type: "thinking", signature: "s".repeat(500) }, { type: "text", text: reply.content }] } };
    expect(context.estimate([system, withBlocks])).toBe(context.estimate([system, reply]));
  });

  it("knows when a request was too long, and how large the window is", () => {
    const errors = [
      ["400 This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens", 131_072],
      ["400 prompt is too long: 210000 tokens > 200000 maximum", 200_000],
      ["400 The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).", 1_048_576],
      ["400 Prompt contains 140000 tokens and 0 draft tokens, too large for model with 131,072 maximum context length", 131_072],
    ];
    const huge = [system, { role: "user", content: "x".repeat(4_000_000) }];
    for (const [message, limit] of errors) {
      const context = new ContextWindow({ limit: 2_000_000 });
      expect(context.overflowed(new Error(message), huge)).toBe(true);
      expect(context.limit).toBe(limit);
    }

    // Without a number, the window must be smaller than the request that failed.
    const context = new ContextWindow();
    const messages = [system, { role: "user", content: "x".repeat(30_000) }];
    const sent = context.estimate(messages);
    expect(context.overflowed(new Error("413 Request has too many tokens"), messages)).toBe(true);
    expect(context.limit).toBe(Math.floor(sent * 0.9));

    // Other errors aren't about the window.
    const other = new ContextWindow({ limit: 8000 });
    expect(other.overflowed(new Error("401 No auth credentials found"), messages)).toBe(false);
    expect(other.limit).toBe(8000);
    expect(isOverflowError(new Error("402 Insufficient credits"))).toBe(false);
    expect(isOverflowError(undefined)).toBe(false);
  });
});

describe("fetchModels", () => {
  it("reads each model's context window, and whether it sees images and calls tools", async () => {
    const openai = {
      models: {
        async *list() {
          yield {
            id: "openai/gpt-4o-mini",
            context_length: 128_000,
            architecture: { input_modalities: ["text", "image"] },
            supported_parameters: ["tools", "tool_choice"],
          };
          yield { id: "vendor/small:free", context_length: 8192, architecture: { input_modalities: ["text"] }, supported_parameters: ["temperature"] };
          yield { id: "vendor/unknown" };
        },
      },
    };
    const models = await fetchModels(openai);

    expect([...models]).toEqual([
      ["openai/gpt-4o-mini", { contextLength: 128_000, images: true, tools: true }],
      ["vendor/small:free", { contextLength: 8192, images: false, tools: false }],
      ["vendor/unknown", { contextLength: null, images: null, tools: null }],
    ]);
    expect(modelInfo(models, "openai/gpt-4o-mini").contextLength).toBe(128_000);
    expect(modelInfo(models, "openai/gpt-4o-mini:nitro").contextLength).toBe(128_000);
    expect(modelInfo(models, "vendor/small:free").images).toBe(false);
    expect(modelInfo(models, "vendor/typo")).toBe(null);
    expect(modelInfo(null, "openai/gpt-4o-mini")).toBe(null);

    // A Claude model's alias is the model the list has with its date.
    const claude = new Map([["claude-haiku-4-5-20251001", { contextLength: 200_000 }]]);
    expect(modelInfo(claude, "claude-haiku-4-5").contextLength).toBe(200_000);
    expect(modelInfo(claude, "claude-haiku-4")).toBe(null);
  });
});
