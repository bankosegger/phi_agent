import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandPath, commandTask, findCommand, isCommandLine, loadCommands, nearCommand, parseCommand } from "./commands.mjs";

// A project folder and a home folder, each with these command files in .phi-agent/commands.
function folders({ project = {}, home = {} }) {
  const root = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  for (const [where, files] of [
    ["project", project],
    ["home", home],
  ]) {
    const dir = join(root, where, ".phi-agent", "commands");
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  }
  return { cwd: join(root, "project"), home: join(root, "home"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("parseCommand", () => {
  it("reads a description from the front matter, or else the first line", () => {
    expect(parseCommand("---\ndescription: Review the changes\n---\nLook at git diff.\n")).toEqual({ prompt: "Look at git diff.", description: "Review the changes", model: null });
    expect(parseCommand('---\r\ndescription: "Quoted"\r\n---\r\n\r\nText')).toEqual({ prompt: "Text", description: "Quoted", model: null });
    expect(parseCommand("\n# Fix the tests\n\nRun npm test, then fix what fails.")).toEqual({
      prompt: "# Fix the tests\n\nRun npm test, then fix what fails.",
      description: "Fix the tests",
      model: null,
    });
    expect(parseCommand(`${"x".repeat(80)}`).description).toBe(`${"x".repeat(59)}…`);
    expect(parseCommand("---\ntitle: no description\n---\n").prompt).toBe("");
  });

  it("reads the model to run the command with, if its front matter names one", () => {
    const text = "---\nDescription: Sum up the diff\nmodel:  'claude-haiku-5-5' \n---\nSum up git diff.";
    expect(parseCommand(text)).toEqual({ prompt: "Sum up git diff.", description: "Sum up the diff", model: "claude-haiku-5-5" });
    expect(parseCommand("---\nmodel: openai/gpt-4o-mini\n---\nGo.").model).toBe("openai/gpt-4o-mini");
    // A model ID has no spaces, and an empty one is none.
    expect(parseCommand("---\nmodel: the fast one\n---\nGo.").model).toBeNull();
    expect(parseCommand("---\nmodel:\n---\nGo.").model).toBeNull();
    // "model:" in the prompt, outside the front matter, is just text.
    expect(parseCommand("model: claude-haiku-5-5\nGo.").model).toBeNull();
  });
});

describe("loadCommands", () => {
  it("finds the project's commands and the user's own, the project's winning", () => {
    const { cwd, home, cleanup } = folders({
      project: { "review.md": "Project review", "Fix-Tests.MD": "Fix them", "notes.txt": "not a command", "my notes.md": "not a name", "help.md": "hidden" },
      home: { "review.md": "My review", "explain.md": "---\ndescription: Explain code\n---\nExplain $ARGUMENTS", "empty.md": "  \n" },
    });
    try {
      const { commands, skipped } = loadCommands({ cwd, home, builtIn: ["/help", "/clear"] });
      expect([...commands.keys()].sort()).toEqual(["explain", "fix-tests", "review"]);
      expect(commands.get("review")).toMatchObject({ prompt: "Project review", scope: "project" });
      expect(commands.get("explain")).toMatchObject({ prompt: "Explain $ARGUMENTS", description: "Explain code", scope: "user" });
      expect(commands.get("fix-tests").file).toBe(join(cwd, ".phi-agent", "commands", "Fix-Tests.MD"));
      // The files that aren't commands say why; notes.txt isn't a .md file, so it isn't mentioned.
      expect(skipped.map(({ name, reason }) => [name, reason])).toEqual([
        ["empty", "no prompt in it"],
        ["help", "/help is a built-in command"],
        ["my notes", "not a command name (a letter or digit, then letters, digits, - or _)"],
        ["review", "the project's review.md wins"],
      ]);
      expect(skipped.find(({ name }) => name === "review").file).toBe(join(home, ".phi-agent", "commands", "review.md"));
    } finally {
      cleanup();
    }
  });

  it("finds none without the folders", () => {
    const empty = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    try {
      const { commands, skipped } = loadCommands({ cwd: empty, home: empty });
      expect(commands.size).toBe(0);
      expect(skipped).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("commandTask and findCommand", () => {
  const commands = new Map([
    ["explain", { name: "explain", prompt: "Explain $ARGUMENTS simply. Then explain $ARGUMENTS in depth." }],
    ["review", { name: "review", prompt: "Review the changes." }],
  ]);

  it("puts what follows the command in place of $ARGUMENTS, or after the prompt", () => {
    expect(commandTask(commands.get("explain"), " src/a.js ")).toBe("Explain src/a.js simply. Then explain src/a.js in depth.");
    expect(commandTask(commands.get("review"), "only the parser\nand its tests")).toBe("Review the changes.\n\nonly the parser\nand its tests");
    expect(commandTask(commands.get("review"))).toBe("Review the changes.");
  });

  it("finds the command a message starts with", () => {
    expect(findCommand("/review", commands)).toEqual({ command: commands.get("review"), args: "" });
    expect(findCommand("/Explain src/a.js\nand b.js", commands)).toEqual({ command: commands.get("explain"), args: "src/a.js\nand b.js" });
    expect(findCommand("/reviews", commands)).toBe(null);
    expect(findCommand("/review/x", commands)).toBe(null);
    expect(findCommand("review this", commands)).toBe(null);
  });
});

describe("commandPath", () => {
  it("names a command's file as the user knows it", () => {
    expect(commandPath({ scope: "project", file: join("/p", ".phi-agent", "commands", "review.md") })).toBe(".phi-agent/commands/review.md");
    expect(commandPath({ scope: "user", file: join("/h", ".phi-agent", "commands", "explain.md") })).toBe("~/.phi-agent/commands/explain.md");
  });
});

describe("isCommandLine", () => {
  it("tells a command from a task", () => {
    expect(isCommandLine("/help")).toBe(true);
    expect(isCommandLine("/review src/app.js")).toBe(true);
    expect(isCommandLine("/Fix-Tests")).toBe(true);
    expect(isCommandLine("/src/app.js is broken")).toBe(false);
    expect(isCommandLine("/review/x")).toBe(false);
    expect(isCommandLine("fix /the tests")).toBe(false);
    expect(isCommandLine("/")).toBe(false);
  });
});

describe("nearCommand", () => {
  const names = ["help", "review", "explain", "fix-tests"];

  it("suggests the closest name, within two edits or a prefix of it", () => {
    expect(nearCommand("revie", names)).toBe("review");
    expect(nearCommand("Reviews", names)).toBe("review");
    expect(nearCommand("fix-test", names)).toBe("fix-tests");
    expect(nearCommand("rev", names)).toBe("review");
    expect(nearCommand("hlep", names)).toBe("help");
  });

  it("suggests nothing when no name is close", () => {
    expect(nearCommand("zzzzzz", names)).toBe(null);
    expect(nearCommand("", names)).toBe(null);
  });
});
