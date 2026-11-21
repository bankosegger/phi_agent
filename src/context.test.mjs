import { describe, expect, it } from "vitest";
import { ContextWindow, contextLengthOf, fetchContextLengths, isOverflowError } from "./context.mjs";

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

describe("fetchContextLengths", () => {
  it("reads each model's context window from the model list", async () => {
    const openai = {
      models: {
        async *list() {
          yield { id: "openai/gpt-4o-mini", context_length: 128_000 };
          yield { id: "vendor/small:free", context_length: 8192 };
          yield { id: "vendor/unknown" };
        },
      },
    };
    const lengths = await fetchContextLengths(openai);

    expect([...lengths]).toEqual([
      ["openai/gpt-4o-mini", 128_000],
      ["vendor/small:free", 8192],
    ]);
    expect(contextLengthOf(lengths, "openai/gpt-4o-mini")).toBe(128_000);
    expect(contextLengthOf(lengths, "openai/gpt-4o-mini:nitro")).toBe(128_000);
    expect(contextLengthOf(lengths, "vendor/small:free")).toBe(8192);
    expect(contextLengthOf(lengths, "vendor/typo")).toBe(null);
    expect(contextLengthOf(null, "openai/gpt-4o-mini")).toBe(null);
  });
});
