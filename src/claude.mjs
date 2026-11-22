import Anthropic from "@anthropic-ai/sdk";

// Claude models through the Claude API, with an Anthropic API key. The agent keeps every
// conversation in the OpenAI chat format it uses with OpenRouter; this turns it into Messages API
// requests, and Claude's streamed replies back into that format.
//
// Claude's replies can start with thinking blocks, which must go back to the API unchanged with
// the rest of the conversation. A reply that has them keeps Claude's content blocks as they came,
// in its `claude` field, and is sent back from those. When the conversation is edited (old tool
// output trimmed, earlier tasks summarized), those blocks no longer match it: dropThinking
// forgets them.

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

// Beta features every request uses:
// - server-side fallback: when the model declines a request for policy reasons, the API has its
//   default fallback model carry on instead of stopping. Models without one ignore it.
// - thinking binding controls: thinking blocks that no longer match the conversation, after an
//   edit the agent didn't account for, are dropped instead of failing the request.
const BETAS = ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"];

// The most a reply may take, thinking included, unless the model's limit is lower.
const MAX_OUTPUT_TOKENS = 64_000;

// How often a reply that broke off (a dropped connection, or tool input the SDK couldn't parse)
// is asked for again. API errors are not: the SDK retries the ones worth retrying itself.
const STREAM_RETRIES = 2;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// List prices in dollars per million tokens: [input, output, cache read], from Anthropic's
// pricing in November 2026, to estimate what a task cost, since the API doesn't say. Writing to
// the cache (for 5 minutes) costs 1.25 times the input price.
const PRICES = {
  "claude-fable-5-2": [8, 40, 0.2],
  "claude-mythos-5-2": [8, 40, 0.2],
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-mythos-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-mythos-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-opus-4-5": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-sonnet-4-5": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-haiku-4-5": [1, 5, 0.1],
};
// Claude Haiku 5.5 costs more for a prompt over 100k tokens.
const LONG_PROMPT_PRICES = { "claude-haiku-5-5": { above: 100_000, prices: [0.5, 2.5, 0.05] } };

/** Whether a model is one of the Claude API's, like claude-opus-5-5. */
export function isClaudeModel(model) {
  return /^claude-/i.test(model ?? "");
}

// A model ID without the date some carry, like claude-haiku-4-5-20251001.
function baseId(model) {
  return model.replace(/-\d{8}$/, "");
}

// The version of a model like claude-sonnet-4-6 (4.6), with its family, or null for other names.
function version(model) {
  const match = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i);
  return match && { family: match[1].toLowerCase(), number: Number(match[2]) + Number(match[3] ?? 0) / 10 };
}

/**
 * Whether a model takes adaptive thinking: as the model list says (`about`), or before it has
 * loaded, by its name. Claude 4.6 and later do; Haiku 4.5 and older models don't.
 */
export function thinksAdaptively(model, about = null) {
  if (about?.adaptiveThinking != null) return about.adaptiveThinking;
  const known = version(model);
  if (!known) return false;
  if (known.family === "haiku") return known.number >= 5;
  if (known.family === "opus" || known.family === "sonnet") return known.number >= 4.6;
  return true; // Fable, Mythos, and the families after them
}

function takesEffort(model, about, effort) {
  if (about?.effort) return Boolean(about.effort.supported && about.effort[effort]?.supported !== false);
  return thinksAdaptively(model, about);
}

/**
 * What the Claude API says about each of its models, as a Map from model ID to { contextLength,
 * maxOutput, images, tools, adaptiveThinking, effort }, like fetchModels in context.mjs. Values
 * the list doesn't give are null.
 */
export async function fetchClaudeModels(client) {
  const models = new Map();
  for await (const model of client.models.list()) {
    if (!model.id) continue;
    const capabilities = model.capabilities;
    models.set(model.id, {
      contextLength: model.max_input_tokens > 0 ? model.max_input_tokens : null,
      maxOutput: model.max_tokens > 0 ? model.max_tokens : null,
      images: capabilities?.image_input?.supported ?? null,
      tools: true,
      adaptiveThinking: capabilities?.thinking?.types?.adaptive?.supported ?? null,
      effort: capabilities?.effort ?? null,
    });
  }
  return models;
}

// --- The request ---

function imageBlock(url) {
  const data = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  return { type: "image", source: { type: "url", url } };
}

function userBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return (content ?? []).flatMap((part) => {
    if (part.type === "text") return part.text ? [{ type: "text", text: part.text }] : [];
    if (part.type === "image_url") return [imageBlock(part.image_url.url)];
    return [];
  });
}

function parseInput(json) {
  try {
    const input = JSON.parse(json || "{}");
    return typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  } catch {
    return {}; // invalid arguments, which the model was told about at the time
  }
}

/**
 * The conversation as the Messages API takes it: { system, messages }. Tool results become
 * tool_result blocks in a user message, and messages in a row from the same side are merged,
 * since the API wants turns to alternate, with a turn's tool results first.
 */
export function toClaudeMessages(messages) {
  let system = null;
  const result = [];
  const add = (role, blocks) => {
    if (!blocks.length) return;
    const last = result.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else result.push({ role, content: [...blocks] });
  };

  // Tool call IDs from other models can have characters the API doesn't take, like
  // functions.read_file:0, and repeat. Each call gets an ID the API takes, used by its result too.
  const used = new Set();
  const ids = new Map();
  const claim = (id) => {
    const safe = String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_") || "call";
    let unique = safe;
    for (let n = 2; used.has(unique); n++) unique = `${safe}_${n}`;
    used.add(unique);
    ids.set(id, unique);
    return unique;
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (system == null) system = message.content;
      else add("user", userBlocks(message.content));
    } else if (message.role === "user") {
      add("user", userBlocks(message.content));
    } else if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: ids.get(message.tool_call_id) ?? claim(message.tool_call_id) };
      if (message.content) block.content = String(message.content);
      add("user", [block]);
    } else if (message.role === "assistant") {
      if (message.claude?.content) {
        // Claude's own blocks go back as they came, IDs and all.
        for (const block of message.claude.content) {
          if (block.type !== "tool_use") continue;
          used.add(block.id);
          ids.set(block.id, block.id);
        }
        add("assistant", message.claude.content);
        continue;
      }
      const blocks = message.content?.trim() ? [{ type: "text", text: message.content }] : [];
      for (const call of message.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: claim(call.id), name: call.function.name, input: parseInput(call.function.arguments) });
      }
      add("assistant", blocks);
    }
  }
  return { system: system == null ? undefined : [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: result };
}

// The agent's tools (OpenAI function definitions) as the API takes them. Their input streams as
// it is written, so the progress line can follow a long file being written.
function toClaudeTools(tools) {
  return tools.map(({ function: { name, description, parameters } }) => ({
    name,
    description,
    input_schema: parameters ?? { type: "object", properties: {} },
    eager_input_streaming: true,
  }));
}

/**
 * The Messages API request for a model reply. `about` is what the model list says about the
 * model (see fetchClaudeModels), `effort` an effort level (see EFFORTS), or null for the model's
 * default. With `toolChoice` "none", the model can't call tools.
 * The system prompt, with the tools before it, is cached, and so is the conversation up to its
 * end, which moves along as it grows: each request reads what the one before it wrote.
 */
export function claudeRequest({ model, messages, tools = [], toolChoice = null, about = null, effort = null }) {
  const { system, messages: turns } = toClaudeMessages(messages);
  const request = {
    model,
    max_tokens: Math.min(MAX_OUTPUT_TOKENS, about?.maxOutput ?? MAX_OUTPUT_TOKENS),
    betas: BETAS,
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    ...(system && { system }),
    messages: turns,
    tools: toClaudeTools(tools),
  };
  if (toolChoice === "none") request.tool_choice = { type: "none" };
  if (thinksAdaptively(model, about)) {
    request.thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
  }
  if (effort && takesEffort(model, about, effort)) request.output_config = { effort };
  return request;
}

// --- The reply ---

/** An estimate of what a request cost in dollars, from its usage and list prices, or null. */
export function claudeCost(model, usage) {
  const id = baseId(model ?? "");
  if (!PRICES[id]) return null;
  const input = usage?.input_tokens ?? 0;
  const write = usage?.cache_creation_input_tokens ?? 0;
  const read = usage?.cache_read_input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const long = LONG_PROMPT_PRICES[id];
  const [inPrice, outPrice, readPrice] = long && input + write + read > long.above ? long.prices : PRICES[id];
  return (input * inPrice + write * inPrice * 1.25 + read * readPrice + output * outPrice) / 1e6;
}

// A reply's usage in the shape OpenRouter reports it, which the rest of the agent reads:
// prompt_tokens counts the whole prompt, cached or not.
function usageOf(reply) {
  const usage = reply.usage ?? {};
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const cost = claudeCost(reply.model, usage);
  return {
    prompt_tokens: (usage.input_tokens ?? 0) + read + write,
    completion_tokens: usage.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
    ...(cost != null && { cost, cost_estimated: true }),
  };
}

const CUT_OFF = new Set(["max_tokens", "model_context_window_exceeded"]);
// Content blocks the agent needs nothing more from to send them back as they came.
const PLAIN_BLOCKS = new Set(["text", "tool_use"]);

// The reply's content blocks to send back with the conversation: all of them, except that when
// a model declined and handed over to a fallback model (a `fallback` block), what the declining
// model thought and called before the last handover is left out, as the API asks.
function blocksToKeep(content) {
  const handover = content.findLastIndex((block) => block.type === "fallback");
  return content
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => index >= handover || block.type === "text" || block.type === "fallback");
}

/**
 * Streams a reply from Claude for `request` (see claudeRequest), and resolves to { message, stop,
 * refusal }: the reply as an assistant message for the conversation, and how it stopped: "done",
 * "cut_off" (at the output limit) or "refusal" (the model declined, and refusal.category may
 * say why). Its text goes to `onToken` as it comes. `onToolInput(call)` hears about a tool call
 * as its arguments stream in, `onUsage(usage)` gets the token usage (with an estimated cost),
 * and `onNotice(notice)` hears { type: "retry", error } when the reply broke off and is asked
 * for again, and after the reply, { type: "fallback", from, to, category } if a model declined
 * and another took over. A call's arguments are the JSON as Claude wrote it, so input it cut off
 * or got wrong fails to parse rather than becoming a call with half its content.
 */
export async function streamClaudeReply({ client, request, signal, onToken, onToolInput, onUsage, onNotice }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamOnce({ client, request, signal, onToken, onToolInput, onUsage, onNotice });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Anthropic.APIError || attempt >= STREAM_RETRIES) throw error;
      onNotice?.({ type: "retry", error });
    }
  }
}

// A content block as plain JSON, to keep: without the SDK's own properties, and with tool input
// it couldn't make sense of as {}.
function copyBlock(block) {
  const copy = {};
  for (const key of Object.keys(block)) {
    if (key === "input") {
      try {
        copy.input = block.input;
      } catch {
        copy.input = {};
      }
    } else {
      copy[key] = block[key];
    }
  }
  return JSON.parse(JSON.stringify(copy));
}

async function streamOnce({ client, request, signal, onToken, onToolInput, onUsage, onNotice }) {
  const stream = client.beta.messages.stream(request, { signal });
  const types = new Map(); // each content block's type, by index
  const calls = new Map(); // tool calls as their arguments stream in, by content block
  const handovers = []; // fallback notices, for after the reply, which carries on without a break
  let text = "";
  let paragraphBreak = false; // a text block ended, so another one starts a new paragraph

  const write = (token) => {
    if (paragraphBreak && text) {
      text += "\n\n";
      onToken?.("\n\n");
    }
    paragraphBreak = false;
    text += token;
    onToken?.(token);
  };

  for await (const event of stream) {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      types.set(event.index, block.type);
      if (block.type === "tool_use") {
        const call = { function: { name: block.name, arguments: "" } };
        calls.set(event.index, call);
        onToolInput?.(call);
      } else if (block.type === "fallback") {
        // The new model carries on from the text so far: no paragraph break.
        paragraphBreak = false;
        handovers.push({ type: "fallback", from: block.from?.model ?? null, to: block.to?.model ?? null, category: block.trigger?.category ?? null });
      }
    } else if (event.type === "content_block_delta") {
      const call = calls.get(event.index);
      if (event.delta.type === "text_delta" && event.delta.text) {
        write(event.delta.text);
      } else if (event.delta.type === "input_json_delta" && call) {
        call.function.arguments += event.delta.partial_json;
        onToolInput?.(call);
      }
    } else if (event.type === "content_block_stop" && types.get(event.index) === "text") {
      paragraphBreak = true;
    }
  }
  const reply = await stream.finalMessage();
  onUsage?.(usageOf(reply));
  for (const notice of handovers) onNotice?.(notice);

  if (reply.stop_reason === "refusal") {
    return { message: { role: "assistant", content: text || null }, stop: "refusal", refusal: { category: reply.stop_details?.category ?? null } };
  }

  const kept = blocksToKeep(reply.content);
  const toolCalls = kept
    .filter(({ block }) => block.type === "tool_use")
    .map(({ block, index }) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: calls.get(index)?.function.arguments || "{}" },
    }));
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  // Thinking, and other blocks besides text and tool calls, go back as they came: with text or a
  // tool call to go with them.
  const blocks = kept.map(({ block }) => block);
  if (blocks.some((block) => !PLAIN_BLOCKS.has(block.type)) && blocks.some((block) => PLAIN_BLOCKS.has(block.type))) {
    message.claude = { content: blocks.map(copyBlock) };
  }
  return { message, stop: CUT_OFF.has(reply.stop_reason) ? "cut_off" : "done" };
}

/**
 * Forgets the content blocks Claude's replies came with (see the top of this file), so that they
 * are sent back as text and tool calls only. For after the conversation was edited, when their
 * thinking no longer matches it. Returns how many replies had them.
 */
export function dropThinking(messages) {
  let count = 0;
  for (const message of messages) {
    if (message.claude) {
      delete message.claude;
      count++;
    }
  }
  return count;
}
