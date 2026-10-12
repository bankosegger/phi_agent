import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { createMessages, needsConfirmation, runTool, safeProjectPath, agentTurn } from "./agent-core.mjs";

describe("needsConfirmation", () => {
  it("requires confirmation for risky tools", () => {
    expect(needsConfirmation("shell")).toBe(true);
    expect(needsConfirmation("write_file")).toBe(true);
    expect(needsConfirmation("write_asset")).toBe(true);
    expect(needsConfirmation("edit_file")).toBe(true);
    expect(needsConfirmation("append_file")).toBe(true);
    expect(needsConfirmation("read_file")).toBe(false);
    expect(needsConfirmation("list_dir")).toBe(false);
    expect(needsConfirmation("grep")).toBe(false);
  });
});

describe("safeProjectPath", () => {
  it("blocks absolute paths and parent traversal", () => {
    expect(() => safeProjectPath("/tmp/nope.txt")).toThrow("relative");
    expect(() => safeProjectPath("../nope.txt")).toThrow("inside the project");
  });
});

describe("runTool", () => {
  it("writes and reads project files in subfolders", () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      expect(runTool("write_file", { path: "nested/hello.txt", content: "hello" })).toBe("ok");
      expect(runTool("read_file", { path: "nested/hello.txt" })).toBe("hello");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a line range, lists directories, and greps", () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      runTool("write_file", { path: "src/a.txt", content: "one\ntwo\nthree\n" });
      runTool("write_file", { path: "node_modules/skip.txt", content: "two" });

      expect(runTool("read_file", { path: "src/a.txt", start_line: 2, end_line: 3 })).toBe("two\nthree");
      expect(() => runTool("read_file", { path: "src/a.txt", start_line: 50 })).toThrow("outside the file");

      expect(runTool("list_dir", {})).toBe("src/");
      expect(runTool("list_dir", { path: "src" })).toBe("a.txt");
      expect(runTool("list_dir", { recursive: true })).toBe("src/\nsrc/a.txt");

      expect(runTool("grep", { pattern: "^t" })).toBe("src/a.txt:2:two\nsrc/a.txt:3:three");
      expect(runTool("grep", { pattern: "nothing", path: "src" })).toBe("no matches");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edits a unique string and rejects missing or ambiguous matches", () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      runTool("write_file", { path: "src/a.txt", content: "cat dog dog" });

      expect(runTool("edit_file", { path: "src/a.txt", old_string: "cat", new_string: "$& bird" })).toBe("ok");
      expect(runTool("read_file", { path: "src/a.txt" })).toBe("$& bird dog dog");
      expect(() => runTool("edit_file", { path: "src/a.txt", old_string: "dog", new_string: "x" })).toThrow("2 times");
      expect(() => runTool("edit_file", { path: "src/a.txt", old_string: "fish", new_string: "x" })).toThrow("not found");
      expect(() => runTool("edit_file", { path: "a.txt", old_string: "x", new_string: "y" })).toThrow("Root-level");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to files, creating them if needed", () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      runTool("append_file", { path: "logs/out.txt", content: "a" });
      runTool("append_file", { path: "logs/out.txt", content: "b" });
      expect(runTool("read_file", { path: "logs/out.txt" })).toBe("ab");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks root-level project writes", () => {
    for (const path of ["hello.txt", "./hello.txt", "src/../hello.txt"]) {
      expect(() => runTool("write_file", { path, content: "hello" })).toThrow("Root-level writes are blocked");
    }
  });

  it("returns shell output, stderr and exit code instead of throwing", () => {
    const result = runTool("shell", { cmd: "echo out; echo err >&2; exit 3" });
    expect(result).toContain("out");
    expect(result).toContain("[stderr]\nerr");
    expect(result).toContain("[exit code 3]");
  });

  it("truncates long shell output", () => {
    const result = runTool("shell", { cmd: "head -c 20000 /dev/zero | tr '\\0' a" });
    expect(result).toContain("[truncated 10000 chars]");
  });

  it("stores assets under .agent/assets", () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      expect(runTool("write_asset", { path: "notes/output.txt", content: "asset" })).toBe(
        "saved to .agent/assets/notes/output.txt",
      );
      expect(existsSync(join(dir, ".agent", "assets", "notes", "output.txt"))).toBe(true);
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
