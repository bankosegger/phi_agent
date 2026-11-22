import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli-args.mjs";

const NONE = { continue: false, sandbox: false, print: false, yes: false, plan: false, version: false, help: false, model: null };

describe("parseArgs", () => {
  it("takes the words that aren't options as the task", () => {
    expect(parseArgs([])).toEqual({ options: NONE, task: "" });
    expect(parseArgs(["fix", "the", "tests"])).toEqual({ options: NONE, task: "fix the tests" });
    // An argument is an option only if it is one exactly.
    expect(parseArgs(["explain gcc -c", "--verbose"])).toEqual({ options: NONE, task: "explain gcc -c --verbose" });
  });

  it("reads options before, after and between the words of the task", () => {
    expect(parseArgs(["--sandbox", "add", "tests", "-c"]).options).toEqual({ ...NONE, sandbox: true, continue: true });
    expect(parseArgs(["--plan", "add auth"])).toEqual({ options: { ...NONE, plan: true }, task: "add auth" });
    expect(parseArgs(["-p", "-y", "summarize", "--model", "anthropic/claude-sonnet-5.5"])).toEqual({
      options: { ...NONE, print: true, yes: true, model: "anthropic/claude-sonnet-5.5" },
      task: "summarize",
    });
    expect(parseArgs(["--model=openai/gpt-4o", "--print", "--yes", "--continue", "--help"]).options).toEqual({
      continue: true,
      sandbox: false,
      print: true,
      yes: true,
      plan: false,
      version: false,
      help: true,
      model: "openai/gpt-4o",
    });
    expect(parseArgs(["--version"]).options).toEqual({ ...NONE, version: true });
    expect(parseArgs(["-v"]).options).toEqual({ ...NONE, version: true });
  });

  it("needs a model after --model", () => {
    expect(() => parseArgs(["--model"])).toThrow("--model needs a model ID");
    expect(() => parseArgs(["-m", "--print"])).toThrow("-m needs a model ID");
    expect(() => parseArgs(["--model="])).toThrow("--model= needs a model ID");
  });
});
