import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { commandEnv, killProcessTree } from "./processes.mjs";

// MCP (the Model Context Protocol) servers give the model more tools: a server is a program the
// agent starts, which lists its tools and runs them when asked, in JSON-RPC messages, a line
// each, on its input and output. The servers are in the user's own settings:
//
//   "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } } }
//
// Their tools are offered to the model as mcp__<server>__<tool>.

export const PROTOCOL_VERSION = "2025-06-18";
const START_TIMEOUT_MS = 30_000; // to start and list the tools: npx may download the server first
const CALL_TIMEOUT_MS = 600_000;
const MAX_RESULT_CHARS = 20_000;
const MAX_DESCRIPTION = 1000;
const KEPT_ERROR_LINES = 20;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// --- Starting a server ---

// On Windows, the file a command names: as it is, or with an extension from PATHEXT, in the
// folders of PATH. Null if there's none.
function findOnPath(command, env) {
  const key = (name) => Object.keys(env).find((other) => other.toUpperCase() === name);
  const extensions = (env[key("PATHEXT")] || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const folders = /[\\/]/.test(command) || isAbsolute(command) ? [""] : ["", ...(env[key("PATH")] || "").split(";").filter(Boolean)];
  const names = /\.[^\\/.]+$/.test(command) ? [command, ...extensions.map((ext) => command + ext)] : extensions.map((ext) => command + ext);
  for (const folder of folders) {
    for (const name of names) {
      const file = folder ? join(folder, name) : name;
      try {
        if (existsSync(file) && statSync(file).isFile()) return file;
      } catch {
        // can't be read: not this one
      }
    }
  }
  return null;
}

// cmd.exe's special characters, which a ^ makes literal.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// An argument for a command line cmd.exe reads, quoted as programs read their arguments, and
// with cmd.exe's special characters escaped; twice for a node_modules/.bin shim, which passes
// its arguments through cmd.exe again. (As cross-spawn does; see https://qntm.org/cmd.)
export function cmdArgument(arg, shim = false) {
  const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1");
  return shim ? quoted.replace(CMD_META, "^$1") : quoted;
}

/**
 * How to start a server: { command, args, options } for spawn. On Windows, a .cmd or .bat file,
 * like npx.cmd, can only run in cmd.exe, so it runs there, with its arguments escaped for it.
 */
export function serverSpawn({ command, args = [], env = {} }, { cwd = process.cwd(), platform = process.platform, baseEnv = commandEnv() } = {}) {
  const environment = { ...baseEnv, ...env };
  const options = { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  if (platform !== "win32") return { command, args, options };
  const file = findOnPath(command, environment) ?? command;
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args, options };
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [normalize(file).replace(CMD_META, "^$1"), ...args.map((arg) => cmdArgument(arg, shim))].join(" ");
  return { command: environment.ComSpec || environment.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { ...options, windowsVerbatimArguments: true } };
}

// --- Names ---

// A name the model's API takes for a server's tool: mcp__<server>__<tool>, at most 64
// characters of letters, digits, _ and -. A name cut to fit ends with a hash of the whole.
export function exposedName(server, tool) {
  const safe = (text) => String(text).replace(/[^a-zA-Z0-9_-]/g, "_");
  const name = `mcp__${safe(server)}__${safe(tool)}`;
  if (name.length <= 64) return name;
  const hash = createHash("sha256").update(`${server}\n${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

/** Whether a tool name is an MCP server's tool, like mcp__github__create_issue. */
export function isMcpTool(name) {
  return /^mcp__/.test(String(name ?? ""));
}

// --- Results ---

function clipText(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const half = MAX_RESULT_CHARS / 2;
  return `${text.slice(0, half)}\n[… ${text.length - MAX_RESULT_CHARS} characters left out …]\n${text.slice(-half)}`;
}

/**
 * A tools/call result as the agent's tools return theirs: { content, parts }, the text for the
 * model and the images that follow it (see agentTurn). Throws with the text of a result that is
 * an error.
 */
export function toolResult(result) {
  const texts = [];
  const parts = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === "text") texts.push(String(item.text ?? ""));
    else if (item?.type === "image" && item.data) {
      parts.push({ type: "image_url", image_url: { url: `data:${item.mimeType || "image/png"};base64,${item.data}` } });
      texts.push(`[image ${parts.length} follows]`);
    } else if (item?.type === "resource") {
      const { uri, text, mimeType } = item.resource ?? {};
      texts.push(text != null ? `${uri ? `${uri}:\n` : ""}${text}` : `[resource ${uri ?? ""}${mimeType ? ` (${mimeType})` : ""}]`);
    } else if (item?.type === "resource_link") {
      texts.push(`[link: ${item.uri}${item.name ? ` (${item.name})` : ""}]`);
    } else if (item?.type) {
      texts.push(`[${item.type} left out]`);
    }
  }
  if (!texts.length && result?.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent, null, 2));
  const content = clipText(texts.join("\n").trim() || "(no output)");
  if (result?.isError) throw new Error(content);
  return parts.length ? { content, parts } : { content };
}

// --- A server ---

/**
 * A connection to one MCP server, by its name in the settings and its { command, args, env }.
 * state is "starting", "ready", "failed" (with `error`) or "closed". `tools` are the server's,
 * as the server lists them.
 */
export class McpServer {
  constructor(name, config, { cwd = process.cwd(), clientVersion = "1.0.0", baseEnv } = {}) {
    this.name = name;
    this.config = config;
    this.cwd = cwd;
    this.clientVersion = clientVersion;
    this.baseEnv = baseEnv;
    this.state = "starting";
    this.error = null;
    this.tools = [];
    this.serverInfo = null;
    this.errorLines = []; // the last lines it wrote to stderr, to say why it failed
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.onToolsChanged = null;
  }

  /** Starts the server, introduces the agent, and lists its tools. Never rejects: see `state`. */
  async start({ timeoutMs = START_TIMEOUT_MS } = {}) {
    try {
      const { command, args, options } = serverSpawn(this.config, { cwd: this.cwd, ...(this.baseEnv && { baseEnv: this.baseEnv }) });
      this.child = spawn(command, args, options);
      this.#listen();
      const deadline = AbortSignal.timeout(timeoutMs);
      const init = await this.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: { name: "phi-agent", version: this.clientVersion } },
        { signal: deadline },
      );
      this.serverInfo = init?.serverInfo ?? null;
      this.notify("notifications/initialized");
      this.tools = await this.#listTools(deadline);
      this.state = "ready";
    } catch (error) {
      this.#fail(error.name === "TimeoutError" ? new Error(`it didn't start within ${Math.round(timeoutMs / 1000)}s`) : error);
    }
    return this;
  }

  #listen() {
    let buffered = "";
    this.child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (line) this.#receive(line);
      }
    });
    this.child.stderr.setEncoding("utf8").on("data", (chunk) => {
      const lines = chunk.split(/\r?\n/).filter((line) => line.trim());
      this.errorLines = [...this.errorLines, ...lines].slice(-KEPT_ERROR_LINES);
    });
    this.child.stdin.on("error", () => {}); // a server that ended: the exit says so
    this.child.on("error", (error) => this.#fail(error));
    // "close" rather than "exit": what the server wrote before it ended has been read by then.
    this.child.on("close", (code, signal) => {
      if (this.state === "closed") return;
      const why = this.errorLines.at(-1);
      this.#fail(new Error(`it exited${code != null ? ` with code ${code}` : ` (${signal})`}${why ? `: ${why}` : ""}`));
    });
  }

  #fail(error) {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    this.error = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    if (this.child && this.child.exitCode == null) killProcessTree(this.child);
  }

  #send(message) {
    if (!this.child?.stdin.writable) throw new Error(`the ${this.name} server isn't running`);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.errorLines = [...this.errorLines, line].slice(-KEPT_ERROR_LINES); // not a message: a log line
      return;
    }
    if (message.id != null && !message.method) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message || `error ${message.error.code}`));
      else waiting.resolve(message.result);
    } else if (message.method && message.id != null) {
      this.#answer(message);
    } else if (message.method === "notifications/tools/list_changed" && this.state === "ready") {
      this.#listTools().then(
        (tools) => {
          this.tools = tools;
          this.onToolsChanged?.(this);
        },
        () => {},
      );
    }
  }

  // The server's requests to the agent: it answers pings, and gives the project folder as the
  // root the server works in. It can't do the rest, like sampling.
  #answer({ id, method }) {
    try {
      if (method === "ping") this.#send({ id, result: {} });
      else if (method === "roots/list") this.#send({ id, result: { roots: [{ uri: pathToFileURL(this.cwd).href, name: "project" }] } });
      else this.#send({ id, error: { code: -32601, message: `the agent doesn't do ${method}` } });
    } catch {
      // the server ended
    }
  }

  /** Sends a request and resolves to its result. Aborting `signal` cancels it at the server. */
  request(method, params, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const id = this.nextId++;
      const onAbort = () => {
        this.pending.delete(id);
        try {
          this.notify("notifications/cancelled", { requestId: id, reason: "cancelled by the user" });
        } catch {
          // the server ended
        }
        reject(signal.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = (settle) => (value) => {
        signal?.removeEventListener("abort", onAbort);
        settle(value);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.#send({ id, method, ...(params !== undefined && { params }) });
      } catch (error) {
        this.pending.delete(id);
        done(reject)(error);
      }
    });
  }

  notify(method, params) {
    this.#send({ method, ...(params !== undefined && { params }) });
  }

  async #listTools(signal) {
    const tools = [];
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {}, { signal });
      tools.push(...(Array.isArray(page?.tools) ? page.tools.filter((tool) => tool?.name) : []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Runs one of the server's tools, by its own name. See toolResult for what it resolves to. */
  async callTool(tool, args, { signal, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    if (this.state !== "ready") throw new Error(`the ${this.name} server isn't running${this.error ? `: ${this.error.message}` : ""}`);
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return toolResult(await this.request("tools/call", { name: tool, arguments: args ?? {} }, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new Error(`${tool} took over ${Math.round(timeoutMs / 1000)}s`);
      throw error;
    }
  }

  /** Stops the server. */
  close() {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const { reject } of this.pending.values()) reject(new Error(`the ${this.name} server was stopped`));
    this.pending.clear();
    if (this.child && this.child.exitCode == null) {
      try {
        this.child.stdin.end();
      } catch {
        // already closed
      }
      killProcessTree(this.child);
    }
  }
}

// --- All of them ---

/**
 * The MCP servers of the settings (`servers`, as "mcpServers" has them), started together.
 * `tools` are their tools as the model gets them, and `run(name, args, { signal })` runs one.
 */
export class McpServers {
  constructor(servers = {}, options = {}) {
    this.servers = Object.entries(servers).map(([name, config]) => new McpServer(name, config, options));
    this.started = null;
  }

  /** Starts the servers, resolving once each is ready or has failed. */
  start(options) {
    this.started ??= Promise.all(this.servers.map((server) => server.start(options)));
    return this.started;
  }

  /** Resolves when the servers have started, or after `timeoutMs`, whichever is first. */
  async ready(timeoutMs) {
    if (!this.started) return;
    let timer;
    await Promise.race([this.started, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  // The ready servers' tools by the names the model knows them by, as { server, tool }: made
  // afresh each time, since a server can end, or change its tools, at any time.
  #byName() {
    const byName = new Map();
    for (const server of this.servers) {
      if (server.state !== "ready") continue;
      for (const tool of server.tools) {
        const name = exposedName(server.name, tool.name);
        if (TOOL_NAME.test(name) && !byName.has(name)) byName.set(name, { server, tool });
      }
    }
    return byName;
  }

  /** The ready servers' tools, as the agent's tools are defined (see tools.mjs). */
  get tools() {
    return [...this.#byName()].map(([name, { server, tool }]) => {
      const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
      const description = String(tool.description ?? tool.title ?? "").trim();
      const shown = description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description;
      return {
        type: "function",
        function: {
          name,
          description: `${shown} (from the ${server.name} MCP server)`.trim(),
          parameters: { ...schema, type: "object", properties: schema.properties ?? {} },
        },
      };
    });
  }

  /** Whether `name` is a ready server's tool, by the name the model knows it by. */
  has(name) {
    return this.#byName().has(name);
  }

  /** Runs a tool by the name the model knows it by. See toolResult for what it resolves to. */
  async run(name, args, { signal } = {}) {
    const found = this.#byName().get(name);
    if (!found) throw new Error(`there's no MCP tool ${name}`);
    return found.server.callTool(found.tool.name, args, { signal });
  }

  /** Stops them all. */
  close() {
    for (const server of this.servers) server.close();
  }
}
