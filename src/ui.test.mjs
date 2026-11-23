import { describe, expect, it } from "vitest";
import { stripVTControlCharacters as plain } from "node:util";
import { LEGACY_GLYPHS, UNICODE_GLYPHS, displayWidth } from "./theme.mjs";
import {
  banner,
  commandLines,
  confirmPrompt,
  detailLines,
  excerpt,
  formatDuration,
  formatTokens,
  helpLines,
  markdownAsText,
  numberedLines,
  questionLine,
  ruleScope,
  taskFooter,
  toolCallLine,
} from "./ui.mjs";

const g = UNICODE_GLYPHS;
const lines = (list) => list.map(plain);

describe("toolCallLine", () => {
  it("names a tool call with a verb and what it is about", () => {
    expect(plain(toolCallLine("edit_file", "src/a.js", g))).toBe("● Edit src/a.js");
    expect(plain(toolCallLine("shell", "npm test", g))).toBe("● Run npm test");
    expect(plain(toolCallLine("read_file", "src/a.js (lines 1-20)", g))).toBe("● Read src/a.js (lines 1-20)");
    expect(plain(toolCallLine("new_tool", "", g))).toBe("● new_tool");
  });
});

describe("detailLines", () => {
  it("shows a numbered diff under a tool call, with gaps where lines were left out", () => {
    const diff = [
      { kind: "same", text: "a", number: 9 },
      { kind: "remove", text: "b", number: 10 },
      { kind: "add", text: "B", number: 10 },
      { kind: "gap", text: "" },
      { kind: "same", text: "z", number: 120 },
      { kind: "note", text: "… 3 more lines" },
    ];
    expect(lines(detailLines(diff, g))).toEqual(["    9   a", "   10 - b", "   10 + B", "    ⋮", "  120   z", "      … 3 more lines"]);
  });

  it("shows a command's output, and how it ended", () => {
    const output = [
      { kind: "output", text: "1 test failed" },
      { kind: "error", text: "exit code 1 · 2.5s" },
    ];
    expect(lines(detailLines(output, g))).toEqual(["  │ 1 test failed", "  ✗ exit code 1 · 2.5s"]);
    expect(lines(detailLines([{ kind: "ok", text: "0.4s" }], LEGACY_GLYPHS))).toEqual(["  √ 0.4s"]);
  });
});

describe("confirmPrompt", () => {
  it("asks about the call, offering to allow calls like it for good", () => {
    expect(plain(confirmPrompt("shell", { cmd: "npm test" }, "shell: npm test", g))).toBe('  ? Run this command? y/N · a = always allow "npm test" › ');
    expect(plain(confirmPrompt("edit_file", {}, "edit_file", g))).toBe("  ? Make this edit? y/N · a = always allow edits › ");
    expect(plain(confirmPrompt("fetch_url", {}, "fetch_url: docs.python.org", g))).toBe("  ? Fetch this page? y/N · a = always allow docs.python.org › ");
    // No rule, no "always": a command like rm always asks.
    expect(plain(confirmPrompt("shell", { cmd: "rm -rf dist", background: false }, null, g))).toBe("  ? Run this command? y/N › ");
    expect(plain(confirmPrompt("shell", { background: true }, null, g))).toBe("  ? Start this in the background? y/N › ");
    expect(plain(confirmPrompt("read_file", { path: ".env" }, null, g))).toBe("  ? Let the model read it? y/N › ");
    // In a narrow terminal, the choices are only named, leaving room for the answer.
    expect(plain(confirmPrompt("edit_file", {}, "edit_file", g, 50))).toBe("  ? Make this edit? y/N/a › ");
  });

  it("says what a rule allows", () => {
    expect(ruleScope("shell: npm run build")).toBe('"npm run build"');
    expect(ruleScope("fetch_url: nodejs.org")).toBe("nodejs.org");
    expect(ruleScope("write_file")).toBe("file writes");
    expect(ruleScope("view_image")).toBe("view_image calls");
  });
});

describe("taskFooter", () => {
  const usage = { requests: 3, input: 9400, output: 291, cost: 0.0016 };
  const context = { used: 2560, limit: 128_000 };

  it("sums up a task in a rule across the terminal", () => {
    const footer = plain(taskFooter({ elapsed: 1800, usage, sessionCost: 0.0016, context }, 100, g));
    expect(footer).toMatch(/^── 1\.8s · 9\.4k in · 291 out · \$0\.0016 · 2% of 128k context ─+$/);
    expect(displayWidth(footer)).toBe(99); // one short of the terminal, which would add a blank line
  });

  it("counts tokens in thousands, and a million-token window in millions", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_500)).toBe("12.5k");
    expect(formatTokens(999_900)).toBe("999.9k");
    expect(formatTokens(999_950)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  it("says how much of the prompt came from the cache, and marks estimated costs", () => {
    const claude = { requests: 2, input: 52_000, cached: 48_000, output: 900, cost: 0.034, estimated: true };
    const footer = plain(taskFooter({ elapsed: 4200, usage: claude, sessionCost: 0.1, sessionEstimated: true, context }, 120, g));
    expect(footer).toContain("4.2s · 52k in (48k cached) · 900 out · ~$0.03 (session ~$0.10) · ");
    expect(plain(taskFooter({ elapsed: 4200, usage: claude, context }, 50, g))).toBe("── 4.2s · 52k/900 tokens · ~$0.03 · 2% context ──");
  });

  it("adds the session's cost after the first task, and the context in tokens without a limit", () => {
    const footer = plain(taskFooter({ elapsed: 65_000, usage, sessionCost: 0.03, context: { used: 2560, limit: null } }, 200, g));
    expect(footer).toContain("1m 5s · 9.4k in · 291 out · $0.0016 (session $0.03) · 2.6k tokens of context");
    expect(displayWidth(footer)).toBe(100); // not wider than this, however wide the terminal
  });

  it("fits a narrow terminal with a shorter version, then with less", () => {
    expect(plain(taskFooter({ elapsed: 1600, usage, sessionCost: 0.03, context }, 50, g))).toBe("── 1.6s · 9.4k/291 tokens · $0.0016 · 2% context");
    expect(plain(taskFooter({ elapsed: 1600, usage, sessionCost: 0.03, context }, 30, g))).toBe("── 1.6s · 9.4k/291 tokens ───");
  });

  it("leaves out what it doesn't know", () => {
    expect(plain(taskFooter({ elapsed: 300, usage: { requests: 0 } }, 30, g))).toBe(`── 0.3s ${"─".repeat(21)}`);
  });
});

describe("banner", () => {
  const about = { version: "1.0.0", model: "openai/gpt-4o-mini", project: "~/code/app", following: ["AGENTS.md"] };

  it("shows the model, the project and its instructions in a box", () => {
    const shown = lines(banner(about, 80, g));
    expect(shown[0]).toMatch(/^╭─+╮$/);
    expect(shown).toContain(`│ ${"● Tiny Agent v1.0.0".padEnd(displayWidth(shown[0]) - 4)} │`);
    expect(shown.some((line) => /│ model {4}openai\/gpt-4o-mini +│/.test(line))).toBe(true);
    expect(shown.some((line) => /│ follows {2}AGENTS\.md +│/.test(line))).toBe(true);
    expect(shown.at(-1)).toMatch(/^╰─+╯$/);
    expect(new Set(shown.map(displayWidth)).size).toBe(1); // a straight box
  });

  it("says when the agent may do more, or less, than usual", () => {
    const shown = lines(banner({ ...about, sandbox: true, plan: true, yes: true }, 100, g)).join("\n");
    expect(shown).toContain("sandbox  Docker, with the project at /workspace");
    expect(shown).toContain("mode     plan: looks around and changes nothing");
    expect(shown).toContain("approve  everything, without asking (--yes)");
  });

  it("fits a narrow terminal: no box, and a long path cut in the middle", () => {
    const shown = lines(banner({ ...about, project: "~/a/very/long/path/to/some/project/folder" }, 36, g));
    expect(shown[0]).toBe("● Tiny Agent v1.0.0");
    for (const line of shown) expect(displayWidth(line)).toBeLessThanOrEqual(35);
    expect(shown.find((line) => line.startsWith("project"))).toMatch(/^project {2}~\/a\/.*….*folder$/);
  });
});

describe("helpLines", () => {
  it("lists the commands, keys and tips in columns that fit the terminal", () => {
    const shown = lines(helpLines(60, g));
    expect(shown[0]).toBe("Commands");
    expect(shown.some((line) => /^ {2}\/resume \[n\] +List the saved conversations/.test(line))).toBe(true);
    expect(shown).toContain("Keys");
    expect(shown.some((line) => /^ {2}Ctrl\+C +Cancel the task/.test(line))).toBe(true);
    expect(shown).toContain("Tips");
    for (const line of shown) expect(displayWidth(line)).toBeLessThanOrEqual(59);
    expect(shown).not.toContain("Your commands");
  });

  it("lists the user's own commands, by name", () => {
    const custom = [
      { name: "review", description: "Review the changes for bugs" },
      { name: "explain", description: "" },
    ];
    const shown = lines(helpLines(80, g, custom));
    const at = shown.indexOf("Your commands");
    expect(shown.slice(at, at + 3)).toEqual(["Your commands", `  ${"/explain".padEnd(13)}  `, `  ${"/review".padEnd(13)}  Review the changes for bugs`]);
    expect(shown.indexOf("Commands")).toBeLessThan(at);
    expect(shown.indexOf("Keys")).toBeGreaterThan(at);
  });

  it("notes the command files that were skipped, and why", () => {
    const shown = lines(helpLines(80, g, [{ name: "review", description: "Review the changes" }], [{ file: ".phi-agent/commands/help.md", reason: "/help is a built-in command" }]));
    const at = shown.indexOf("Not used:");
    expect(at).toBeGreaterThan(shown.indexOf("Your commands"));
    expect(shown[at + 1]).toBe("  .phi-agent/commands/help.md — /help is a built-in command");
    expect(shown.indexOf("Keys")).toBeGreaterThan(at);
  });
});

describe("commandLines", () => {
  it("shows one of the user's own commands in full: description, file, and prompt", () => {
    const shown = lines(commandLines({ name: "review", description: "Review the changes", prompt: "Review the uncommitted changes.\nLook at git diff." }, ".phi-agent/commands/review.md"));
    expect(shown).toEqual(["/review  Review the changes", "from .phi-agent/commands/review.md", "", "Review the uncommitted changes.", "Look at git diff."]);
  });

  it("leaves out the description and file line's extras when there are none", () => {
    const shown = lines(commandLines({ name: "explain", description: "", prompt: "Explain $ARGUMENTS" }, "~/.phi-agent/commands/explain.md"));
    expect(shown).toEqual(["/explain", "from ~/.phi-agent/commands/explain.md", "", "Explain $ARGUMENTS"]);
  });

  it("says which model the command runs with, when its file names one", () => {
    const shown = lines(commandLines({ name: "summary", description: "Sum up", prompt: "Sum up the diff.", model: "claude-haiku-5-5" }, ".phi-agent/commands/summary.md"));
    expect(shown[1]).toBe("from .phi-agent/commands/summary.md · runs with claude-haiku-5-5");
  });
});

describe("markdownAsText", () => {
  it("leaves out markdown's marks, for a preview", () => {
    expect(markdownAsText("## **Fixed** the `add` test, see [docs](https://x.org)")).toBe("Fixed the add test, see docs");
    expect(markdownAsText("snake_case and 2*3*4 stay")).toBe("snake_case and 2*3*4 stay");
  });
});

describe("numberedLines", () => {
  it("numbers items, lining them up", () => {
    expect(lines(numberedLines(["a", "b"]))).toEqual(["  1  a", "  2  b"]);
    expect(lines(numberedLines(Array.from({ length: 10 }, (_, i) => `item ${i + 1}`)))[9]).toBe("  10  item 10");
    expect(lines(numberedLines(Array.from({ length: 10 }, (_, i) => `item ${i + 1}`)))[0]).toBe("   1  item 1");
  });

  it("keeps the numbers it is given, with an item's further lines under its text", () => {
    expect(lines(numberedLines([["first", "under first"], "second"], [3, 12]))).toEqual(["   3  first", "      under first", "  12  second"]);
    expect(numberedLines([])).toEqual([]);
  });
});

describe("excerpt", () => {
  const text = "please look at the build script, then fix the flaky parser test that fails on Windows only";

  it("keeps short text whole, on one line", () => {
    expect(excerpt("fix the\n  parser", ["parser"])).toBe("fix the parser");
  });

  it("shows the part around the first word it finds, in any case, cut to fit", () => {
    // Cut between words, the word found a little way in.
    expect(excerpt(text, ["PARSER", "windows"], 40)).toBe("…the flaky parser test that fails on…");
    // Near the end, it ends with the text; near the start, it starts with it.
    expect(excerpt(text, ["only"], 40)).toBe("…parser test that fails on Windows only");
    expect(excerpt(text, ["please"], 40)).toBe("please look at the build script, then…");
    // Without the words, the start.
    expect(excerpt(text, ["missing"], 40)).toBe("please look at the build script, then…");
    // A long word is cut where it must be, and the excerpt is never longer than asked.
    const word = "x".repeat(100);
    expect(excerpt(`${word} needle ${word}`, ["needle"], 30)).toBe(`…needle ${"x".repeat(21)}…`);
    for (const words of [["parser"], ["only"], ["please"], ["fails"]]) {
      for (const max of [20, 33, 40, 61]) expect(excerpt(text, words, max).length).toBeLessThanOrEqual(max);
    }
  });
});

describe("questionLine", () => {
  it("asks a question, with the choices and where the answer goes", () => {
    expect(plain(questionLine("Delete this?"))).toBe("  ? Delete this? y/N › ");
    expect(plain(questionLine("Delete it?", "yesterday · y/N"))).toBe("  ? Delete it? yesterday · y/N › ");
  });
});

describe("formatDuration", () => {
  it("shows tenths of a second for short times, and minutes and hours for long ones", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(9_940)).toBe("9.9s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(725_000)).toBe("12m 5s");
    expect(formatDuration(7_380_000)).toBe("2h 3m");
  });
});
