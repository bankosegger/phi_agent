import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServers, cmdArgument, exposedName, isMcpTool, serverSpawn, toolResult } from "./mcp.mjs";

const SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const fake = (...args) => ({ command: process.execPath, args: [SERVER, ...args], env: {} });

let running = [];
afterEach(() => {
  for (const servers of running) servers.close();
  running = [];
});

async function started(config, options) {
  const servers = new McpServers(config, options);
  running.push(servers);
  await servers.start(options);
  return servers;
}

describe("McpServers", () => {
  it("starts a server, lists its tools page by page, and offers them as mcp__<server>__<tool>", async () => {
    const servers = await started({ fake: fake() });
    const [server] = servers.servers;
    expect(server.state).toBe("ready");
    expect(server.serverInfo).toEqual({ name: "fake", version: "1.0.0" });
    expect(server.tools.map((tool) => tool.name)).toEqual(["echo", "add", "fail", "image", "slow", "ask", "change", "crash", "cancelled", "argv"]);

    const echo = servers.tools.find((tool) => tool.function.name === "mcp__fake__echo");
    expect(echo.function).toEqual({
      name: "mcp__fake__echo",
      description: "Says the text back (from the fake MCP server)",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    // A tool without a schema takes an object anyway, as the model's API needs.
    expect(servers.tools.find((tool) => tool.function.name === "mcp__fake__fail").function.parameters).toEqual({ type: "object", properties: {} });
    expect(servers.has("mcp__fake__echo")).toBe(true);
    expect(servers.has("mcp__other__echo")).toBe(false);
  });

  it("runs tools: text, structured content, images (which follow as parts) and errors", async () => {
    const servers = await started({ fake: fake() });
    expect(await servers.run("mcp__fake__echo", { text: "hello" })).toEqual({ content: "hello" });
    expect(await servers.run("mcp__fake__add", { a: 2, b: 3 })).toEqual({ content: '{\n  "sum": 5\n}' });
    expect(await servers.run("mcp__fake__image", {})).toEqual({
      content: "a dot:\n[image 1 follows]",
      parts: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }],
    });
    await expect(servers.run("mcp__fake__fail", {})).rejects.toThrow("it broke");
    await expect(servers.run("mcp__fake__nope", {})).rejects.toThrow("there's no MCP tool mcp__fake__nope");
  });

  it("answers the server's own requests: a ping, the project as its root, and no to the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    const servers = await started({ fake: fake() }, { cwd: dir });
    try {
      const { content } = await servers.run("mcp__fake__ask", {});
      expect(JSON.parse(content)).toEqual({ ping: {}, roots: [{ uri: pathToFileURL(dir).href, name: "project" }], sampling: -32601 });
    } finally {
      // Windows can't delete the folder a process runs in until it has ended.
      servers.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("cancels a call when its signal aborts, telling the server", async () => {
    const servers = await started({ fake: fake() });
    const controller = new AbortController();
    const call = servers.run("mcp__fake__slow", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled by user")), 50);
    await expect(call).rejects.toThrow("cancelled by user");
    // The server heard which request was cancelled: the one after initialize and the two lists.
    expect(JSON.parse((await servers.run("mcp__fake__cancelled", {})).content)).toEqual([4]);
  });

  it("follows a server whose tools change", async () => {
    const servers = await started({ fake: fake() });
    const changes = [];
    servers.servers[0].onToolsChanged = (server) => changes.push(server.name);
    await servers.run("mcp__fake__change", {});
    await expect.poll(() => changes).toEqual(["fake"]);
    expect(servers.has("mcp__fake__added")).toBe(true);
  });

  it("says why a server isn't running: it couldn't start, it exited, or it didn't answer", async () => {
    const servers = await started(
      {
        missing: { command: "no-such-mcp-server-anywhere", args: [], env: {} },
        silent: fake("--silent"),
        crashing: fake(),
      },
      { timeoutMs: 1500 },
    );
    const [missing, silent, crashing] = servers.servers;
    expect(missing.state).toBe("failed");
    expect(missing.error.message).toMatch(/ENOENT|not recognized|exited with code/);
    expect(silent.state).toBe("failed");
    expect(silent.error.message).toBe("it didn't start within 2s");

    expect(crashing.state).toBe("ready");
    await expect(servers.run("mcp__crashing__crash", {})).rejects.toThrow("it exited with code 3: fatal: out of cheese");
    expect(crashing.state).toBe("failed");
    // Its tools are gone, and calling one says why.
    expect(servers.tools.some((tool) => tool.function.name.startsWith("mcp__crashing__"))).toBe(false);
    await expect(servers.servers[2].callTool("echo", { text: "x" })).rejects.toThrow("the crashing server isn't running: it exited with code 3");
  });

  it("waits for the servers only so long", async () => {
    const servers = new McpServers({ silent: fake("--silent") });
    running.push(servers);
    servers.start({ timeoutMs: 5000 });
    const before = Date.now();
    await servers.ready(200);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(servers.servers[0].state).toBe("starting");
    expect(servers.tools).toEqual([]);
  });
});

describe("exposedName", () => {
  it("names a server's tool as the model's API takes names", () => {
    expect(exposedName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(exposedName("my.server", "get file")).toBe("mcp__my_server__get_file");
    const long = exposedName("server", "a".repeat(80));
    expect(long).toMatch(/^mcp__server__a+_[0-9a-f]{8}$/);
    expect(long).toHaveLength(64);
    expect(exposedName("server", `${"a".repeat(80)}b`)).not.toBe(long);
    expect(isMcpTool("mcp__github__x")).toBe(true);
    expect(isMcpTool("read_file")).toBe(false);
  });
});

describe("toolResult", () => {
  it("turns what a tool returns into text for the model", () => {
    expect(
      toolResult({
        content: [
          { type: "resource", resource: { uri: "file:///a.txt", text: "inside" } },
          { type: "resource", resource: { uri: "file:///b.bin", mimeType: "application/zip" } },
          { type: "resource_link", uri: "file:///c.txt", name: "c" },
          { type: "audio", data: "…" },
        ],
      }),
    ).toEqual({ content: "file:///a.txt:\ninside\n[resource file:///b.bin (application/zip)]\n[link: file:///c.txt (c)]\n[audio left out]" });
    expect(toolResult({ content: [] })).toEqual({ content: "(no output)" });
    const long = toolResult({ content: [{ type: "text", text: "x".repeat(30_000) }] }).content;
    expect(long).toContain("[… 10000 characters left out …]");
    expect(long.length).toBeLessThan(20_100);
  });
});

describe("serverSpawn", () => {
  it("starts a program as it is, outside Windows", () => {
    const { command, args, options } = serverSpawn({ command: "npx", args: ["-y", "a b"], env: { TOKEN: "t" } }, { platform: "linux", baseEnv: { PATH: "/bin" }, cwd: "/project" });
    expect([command, args]).toEqual(["npx", ["-y", "a b"]]);
    expect(options).toMatchObject({ cwd: "/project", env: { PATH: "/bin", TOKEN: "t" } });
  });

  it("runs a .cmd file on Windows in cmd.exe, with its arguments escaped", () => {
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    try {
      writeFileSync(join(dir, "fake.cmd"), "@echo off\r\n");
      writeFileSync(join(dir, "tool.exe"), "");
      const baseEnv = { Path: dir, PATHEXT: ".exe;.cmd", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
      const run = serverSpawn({ command: "fake", args: ["a b", 'say "hi"', "100%"] }, { platform: "win32", baseEnv });
      expect(run.command).toBe("C:\\Windows\\system32\\cmd.exe");
      expect(run.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(run.args[3]).toBe(`"${join(dir, "fake.cmd").replace(/([()\][%!^"`<>&|;, *?])/g, "^$1")} ^"a^ b^" ^"say^ \\^"hi\\^"^" ^"100^%^""`);
      expect(run.options.windowsVerbatimArguments).toBe(true);
      // An .exe runs as it is.
      expect(serverSpawn({ command: "tool", args: ["x"] }, { platform: "win32", baseEnv })).toMatchObject({ command: join(dir, "tool.exe"), args: ["x"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes an argument for cmd.exe, twice for a node_modules/.bin shim", () => {
    expect(cmdArgument("plain")).toBe('^"plain^"');
    expect(cmdArgument("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
    expect(cmdArgument("x&y", true)).toBe('^^^"x^^^&y^^^"');
  });

  it.runIf(process.platform === "win32")("gets the arguments through a .cmd file to the server unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiny agent "));
    try {
      writeFileSync(join(dir, "fake-mcp.cmd"), `@"${process.execPath}" "${SERVER}" %*\r\n`);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
      const args = ["a b", 'say "hi"', "100%", "x&y|z", "^caret", "(paren)", "trailing\\"];
      const servers = await started({ fake: { command: "fake-mcp", args, env: {} } }, { baseEnv: { ...env, Path: `${dir};${process.env.Path ?? process.env.PATH}` } });
      expect(servers.servers[0].state).toBe("ready");
      expect(JSON.parse((await servers.run("mcp__fake__argv", {})).content)).toEqual(args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
