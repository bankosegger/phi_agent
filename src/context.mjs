import { tools } from "./tools.mjs";

// Keeps a conversation inside the model's context window. Old tool output goes first, since the
// model can run a tool again; when that isn't enough, agentTurn has the model summarize the
// earlier conversation (see compactMessages in agent-core.mjs).

export const DEFAULT_CONTEXT_LIMIT = 128_000; // tokens, for a model whose window isn't known
const FULL = 0.75; // make room when a request would fill this share of the window,
const TRIM_TO = 0.5; // trimming down to this share, so it happens rarely and cached prompts stay valid
const KEEP_CHARS = 300; // tool output and arguments this short are always kept
const DEFAULT_CHARS_PER_TOKEN = 3; // until a reply says how many tokens a request took
const TOOLS_CHARS = JSON.stringify(tools).length;
// An image costs the model about as much as this many characters of text (around 1,500
// tokens), however many bytes it has.
const IMAGE_CHARS = 5000;
const IMAGE_STAND_IN = "x".repeat(IMAGE_CHARS);
const IMAGE_REMOVED = "[image removed to save context space; look at it again if you need it]";

// Error messages that mean a request was too long, and where they state the model's window.
const OVERFLOW = /context length|context window|too many tokens|prompt is too long|too large for (the )?model|exceeds the maximum number of tokens/i;
const STATED_LIMITS = [
  /maximum context length is (\d[\d,]*)/i, // OpenAI, OpenRouter, DeepSeek
  />\s*(\d[\d,]*) maximum/i, // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum"
  /maximum number of tokens allowed \((\d[\d,]*)\)/i, // Gemini
  /(\d[\d,]*) maximum context length/i, // Mistral
];

/** Whether a failed request failed because it was too long for the model's context window. */
export function isOverflowError(error) {
  return OVERFLOW.test(String(error?.message ?? ""));
}

// The length of a message (or messages) as JSON, counting each image as IMAGE_CHARS. The content
// blocks a reply from the Claude API keeps (see claude.mjs) repeat its text and tool calls, so
// they don't count.
function size(value) {
  return JSON.stringify(value, (key, part) => {
    if (key === "claude") return undefined;
    return key === "url" && typeof part === "string" && part.startsWith("data:") ? IMAGE_STAND_IN : part;
  }).length;
}

// Characters in a request: the messages as JSON, plus the tool definitions sent with them.
function requestChars(messages) {
  return size(messages) + TOOLS_CHARS;
}

function shrinkArguments(json) {
  if (json.length <= KEEP_CHARS) return json;
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    return "{}"; // invalid arguments, which the model was told about at the time
  }
  if (typeof args !== "object" || args === null) return "{}";
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > KEEP_CHARS) {
      args[key] = `[${value.length} characters removed to save context space]`;
    }
  }
  return JSON.stringify(args);
}

// Replaces a long tool result, the long arguments of tool calls (like the content of a file the
// model wrote), or images, with a short note. Returns how many characters that saved.
function shrink(message) {
  const before = size(message);
  if (message.role === "tool" && typeof message.content === "string" && message.content.length > KEEP_CHARS) {
    message.content = `[${message.content.length} characters of old tool output removed to save context space; run the tool again if you need it]`;
  } else if (message.role === "assistant" && message.tool_calls) {
    for (const call of message.tool_calls) call.function.arguments = shrinkArguments(call.function.arguments);
  } else if (Array.isArray(message.content)) {
    message.content = message.content.map((part) => (part.type === "image_url" ? { type: "text", text: IMAGE_REMOVED } : part));
  }
  return before - size(message);
}

export class ContextWindow {
  /** The model's context window in tokens, or null if it isn't known. */
  limit = null;
  /** The tokens the conversation took up at the last request (prompt and reply), or null. */
  used = null;
  #charsPerToken = DEFAULT_CHARS_PER_TOKEN;

  constructor({ limit = null } = {}) {
    this.limit = limit;
  }

  get #window() {
    return this.limit ?? DEFAULT_CONTEXT_LIMIT;
  }

  /** Roughly how many tokens a request with these messages takes. */
  estimate(messages) {
    return Math.ceil(requestChars(messages) / this.#charsPerToken);
  }

  /** Learns from a reply's token usage how full the window is, and how long a token is. */
  measure(messages, usage) {
    const prompt = usage?.prompt_tokens;
    if (!(prompt > 0)) return;
    this.#charsPerToken = Math.min(8, Math.max(1.5, requestChars(messages) / prompt));
    this.used = prompt + (usage.completion_tokens ?? 0);
  }

  /** Whether a request with these messages would fill too much of the window. */
  isFull(messages) {
    return this.estimate(messages) > this.#window * FULL;
  }

  /**
   * Replaces long tool output and tool-call arguments with short notes, oldest first, until the
   * conversation fills at most half the window. The newest tool results, which the model hasn't
   * seen yet, are kept unless `keepNewest` is false. Returns how many messages it shortened.
   */
  trim(messages, { keepNewest = true } = {}) {
    let excess = requestChars(messages) - this.#window * TRIM_TO * this.#charsPerToken;
    const end = keepNewest ? messages.findLastIndex((message) => message.role === "assistant") : messages.length;
    let trimmed = 0;
    for (let i = 1; i < end && excess > 0; i++) {
      const saved = shrink(messages[i]);
      if (saved > 0) {
        excess -= saved;
        trimmed++;
      }
    }
    return trimmed;
  }

  /**
   * After a request failed: whether it was too long for the model. If so, later requests are fit
   * into the window the error states, or else into a bit less than this request took.
   */
  overflowed(error, messages) {
    if (!isOverflowError(error)) return false;
    const text = String(error.message);
    const stated = Number(STATED_LIMITS.map((pattern) => text.match(pattern)?.[1]).find(Boolean)?.replaceAll(",", ""));
    this.limit = Math.min(this.#window, stated > 0 ? stated : Infinity, Math.floor(this.estimate(messages) * 0.9));
    return true;
  }

  /** For a new conversation. */
  reset() {
    this.used = null;
  }
}

/**
 * What OpenRouter says about each model it lists, as a Map from model ID to { contextLength (in
 * tokens, or null), images (whether it can see them), tools (whether it can call tools) }.
 * images and tools are null when the list doesn't say.
 */
export async function fetchModels(openai) {
  const models = new Map();
  for await (const model of openai.models.list()) {
    if (!model.id) continue;
    const inputs = model.architecture?.input_modalities;
    const parameters = model.supported_parameters;
    models.set(model.id, {
      contextLength: model.context_length > 0 ? model.context_length : null,
      images: Array.isArray(inputs) ? inputs.includes("image") : null,
      tools: Array.isArray(parameters) ? parameters.includes("tools") : null,
    });
  }
  return models;
}

/**
 * A model's entry from fetchModels (or fetchClaudeModels), or null. Variants like :free are their
 * model's, and an alias like claude-haiku-4-5 is the entry with its date, claude-haiku-4-5-20251001.
 */
export function modelInfo(models, model) {
  if (!models || !model) return null;
  const found = models.get(model) ?? models.get(model.replace(/:[^/:]*$/, ""));
  if (found) return found;
  for (const [id, about] of models) {
    if (id.startsWith(`${model}-`) && /^\d{8}$/.test(id.slice(model.length + 1))) return about;
  }
  return null;
}
