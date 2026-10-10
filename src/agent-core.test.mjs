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
    expect(() => runTool("write_file", { path: "hello.txt", content: "hello" })).toThrow(
      "Root-level writes are blocked",
    );
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
});
