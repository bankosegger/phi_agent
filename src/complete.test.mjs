import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeLine } from "./complete.mjs";

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COMMANDS = ["/help", "/clear", "/compact", "/model", "/exit"];

describe("completeLine", () => {
  it("completes command names", () => {
    expect(completeLine("/c", { commands: COMMANDS })).toEqual([["/clear", "/compact"], "/c"]);
    expect(completeLine("/", { commands: COMMANDS })).toEqual([COMMANDS, "/"]);
    expect(completeLine("/x", { commands: COMMANDS })).toEqual([[], "/x"]);
  });

  it("completes model IDs after /model", () => {
    const models = ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", "openai/gpt-4o-mini"];
    expect(completeLine("/model anthropic/claude-s", { models })).toEqual([["anthropic/claude-sonnet-5.5"], "anthropic/claude-s"]);
    expect(completeLine("/model ", { models })).toEqual([models, ""]);
  });

  it("completes the path the last word starts, keeping an @ in front of it", () => {
    inTempDir((cwd) => {
      mkdirSync(join(cwd, "src", "lib"), { recursive: true });
      writeFileSync(join(cwd, "src", "app.js"), "");
      writeFileSync(join(cwd, "src", "api.js"), "");
      writeFileSync(join(cwd, "src", ".env"), "");
      writeFileSync(join(cwd, "README.md"), "");

      expect(completeLine("fix src/ap", { cwd })).toEqual([["src/api.js", "src/app.js"], "src/ap"]);
      expect(completeLine("look at @src/l", { cwd })).toEqual([["src/lib/"], "src/l"]);
      expect(completeLine("fix src/", { cwd })).toEqual([["src/api.js", "src/app.js", "src/lib/"], "src/"]);
      expect(completeLine("show src/.e", { cwd })).toEqual([["src/.env"], "src/.e"]);
      expect(completeLine("read RE", { cwd })).toEqual([["README.md"], "RE"]);
      expect(completeLine(`${join(cwd, "src")}/ap`, { cwd })[0]).toEqual([`${join(cwd, "src")}/api.js`, `${join(cwd, "src")}/app.js`]);
      // A path starting with "/" (all absolute paths, outside Windows) isn't a command.
      expect(completeLine("/src/ap", { cwd: "/", commands: COMMANDS })[1]).toBe("/src/ap");
      // Nothing to complete after a space, or in a folder that isn't there.
      expect(completeLine("fix ", { cwd })).toEqual([[], "fix "]);
      expect(completeLine("fix nope/x", { cwd })).toEqual([[], "nope/x"]);
    });
  });
});
