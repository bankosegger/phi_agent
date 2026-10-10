import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessages, needsConfirmation, runTool, agentTurn } from "./agent-core.mjs";

describe("needsConfirmation", () => {
  it("requires confirmation for risky tools", () => {
    expect(needsConfirmation("shell")).toBe(true);
    expect(needsConfirmation("write_file")).toBe(true);
    expect(needsConfirmation("read_file")).toBe(false);
  });
});

describe("runTool", () => {
  it("writes and reads files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    const path = join(dir, "nested", "hello.txt");

    try {
      expect(runTool("write_file", { path, content: "hello" })).toBe("ok");
      expect(runTool("read_file", { path })).toBe("hello");
    } finally {
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
