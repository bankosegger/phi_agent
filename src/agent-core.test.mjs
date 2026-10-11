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
    expect(needsConfirmation("read_file")).toBe(false);
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

describe("agentTurn", () => {
  it("returns the final model message", async () => {
    const openai = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }] }),
        },
      },
    };

    await expect(
      agentTurn({
        task: "test",
        openai,
        messages: createMessages(),
        confirmTool: async () => true,
        log: () => {},
      }),
    ).resolves.toBe("done");
  });

  it("reports malformed tool arguments back to the model", async () => {
    const replies = [
      { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "read_file", arguments: "{bad" } }] },
      { role: "assistant", content: "recovered" },
    ];
    const openai = { chat: { completions: { create: async () => ({ choices: [{ message: replies.shift() }] }) } } };
    const messages = createMessages();

    await expect(
      agentTurn({ task: "test", openai, messages, confirmTool: async () => true, log: () => {} }),
    ).resolves.toBe("recovered");
    expect(messages.find((m) => m.role === "tool").content).toMatch(/^error: /);
  });
});
