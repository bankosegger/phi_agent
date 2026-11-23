import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { diffLines, previewToolCall, previewToolResult } from "./preview.mjs";

function inTempDir(fn) {
  const originalCwd = cwd();
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  try {
    chdir(dir);
    return fn(dir);
  } finally {
    chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("diffLines", () => {
  it("finds the lines removed and added", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    expect(diffLines([], ["new"])).toEqual([{ kind: "add", text: "new" }]);
    expect(diffLines(["same"], ["same"])).toEqual([{ kind: "same", text: "same" }]);
  });
});

describe("previewToolCall", () => {
  it("shows what an MCP server's tool is given, an argument a line, and the start of its answer", () => {
    const args = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`k${i}`, i]));
    const { summary, lines } = previewToolCall("mcp__github__create_issue", { title: "Bug", labels: ["a"], ...args });
    expect(summary).toBe("");
    expect(lines.slice(0, 2)).toEqual([
      { kind: "note", text: 'title: "Bug"' },
      { kind: "note", text: 'labels: ["a"]' },
    ]);
    expect(lines.at(-1)).toEqual({ kind: "note", text: "… 4 more" });
    expect(previewToolResult("mcp__github__create_issue", { status: "ok", content: "one\n\ntwo\nthree\nfour\n" })).toEqual([
      { kind: "output", text: "one" },
      { kind: "output", text: "two" },
      { kind: "output", text: "three" },
      { kind: "note", text: "… 1 more lines" },
    ]);
  });

  it("shows a to-do list a step a line, with how many are done", () => {
    const todos = [
      { content: "Read the parser", status: "completed" },
      { content: "Add tests", status: "in_progress" },
      { content: "Fix the bug", status: "pending" },
    ];
    expect(previewToolCall("todo_write", { todos })).toEqual({
      summary: "1 of 3 done",
      lines: [
        { kind: "todo", status: "completed", text: "Read the parser" },
        { kind: "todo", status: "in_progress", text: "Add tests" },
        { kind: "todo", status: "pending", text: "Fix the bug" },
      ],
    });
    expect(previewToolCall("todo_write", { todos: [] })).toEqual({ summary: "cleared", lines: [] });
    // A list that isn't one still shows, before the call is refused.
    expect(previewToolCall("todo_write", { todos: "all of it" })).toEqual({ summary: "cleared", lines: [] });
    expect(previewToolCall("todo_write", { todos: [null, { status: "pending" }] }).lines).toEqual([{ kind: "todo", status: "pending", text: "" }]);
  });

  it("shows an edit as removed and added lines", () => {
    expect(previewToolCall("edit_file", { path: "src/a.js", old_string: "a\nb", new_string: "c\n" })).toEqual({
      summary: "src/a.js",
      lines: [
        { kind: "remove", text: "a" },
        { kind: "remove", text: "b" },
        { kind: "add", text: "c" },
      ],
    });
  });

  it("shows only the changed lines of an edit, with a little context", () => {
    // Without the file, there are no line numbers to show.
    const old = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    expect(previewToolCall("edit_file", { path: "src/missing.js", old_string: old, new_string: old.replace("6", "six") }).lines).toEqual([
      { kind: "same", text: "4" },
      { kind: "same", text: "5" },
      { kind: "remove", text: "6" },
      { kind: "add", text: "six" },
      { kind: "same", text: "7" },
    ]);
  });

  it("numbers an edit's lines as they are in the file, with a gap between changes", () => {
    inTempDir(() => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      writeFileSync("a.txt", `${lines.join("\r\n")}\r\n`);
      // Lines 10 to 20, with 12 changed, 14 removed and a line added after 19.
      const old_string = lines.slice(9, 20).join("\n");
      const new_string = old_string.replace("line 12", "LINE 12").replace("line 14\n", "").replace("line 19", "line 19\nnew line");
      expect(previewToolCall("edit_file", { path: "a.txt", old_string, new_string }).lines).toEqual([
        { kind: "same", text: "line 10", number: 10 },
        { kind: "same", text: "line 11", number: 11 },
        { kind: "remove", text: "line 12", number: 12 },
        { kind: "add", text: "LINE 12", number: 12 },
        { kind: "same", text: "line 13", number: 13 },
        { kind: "remove", text: "line 14", number: 14 },
        { kind: "same", text: "line 15", number: 14 },
        { kind: "same", text: "line 16", number: 15 },
        { kind: "gap", text: "" },
        { kind: "same", text: "line 18", number: 17 },
        { kind: "same", text: "line 19", number: 18 },
        { kind: "add", text: "new line", number: 19 },
        { kind: "note", text: "… 1 more line" }, // previews stop at 12 lines
      ]);
      // Text that is in the file twice has no one place, so no numbers.
      writeFileSync("b.txt", "x\ny\nx\n");
      expect(previewToolCall("edit_file", { path: "b.txt", old_string: "x", new_string: "z" }).lines).toEqual([
        { kind: "remove", text: "x" },
        { kind: "add", text: "z" },
      ]);
    });
  });

  it("shows what overwriting a file changes, and where", () => {
    inTempDir(() => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      mkdirSync("src");
      writeFileSync("src/old.txt", `${lines.join("\r\n")}\r\n`); // line endings don't count as changes
      const content = `${lines.join("\n").replace("line 15", "LINE 15")}\n`;

      expect(previewToolCall("write_file", { path: "src/old.txt", content })).toEqual({
        summary: "src/old.txt (overwrites existing file, 20 → 20 lines)",
        lines: [
          { kind: "same", text: "line 13", number: 13 },
          { kind: "same", text: "line 14", number: 14 },
          { kind: "remove", text: "line 15", number: 15 },
          { kind: "add", text: "LINE 15", number: 15 },
          { kind: "same", text: "line 16", number: 16 },
          { kind: "same", text: "line 17", number: 17 },
        ],
      });
      expect(previewToolCall("write_file", { path: "src/old.txt", content: lines.join("\n") })).toEqual({
        summary: "src/old.txt (overwrites existing file, no changes)",
        lines: [],
      });

      // After a line is added, a removed line keeps its number in the old file.
      writeFileSync("src/abc.txt", "a\nb\nc\n");
      expect(previewToolCall("write_file", { path: "src/abc.txt", content: "a\nX\nb\n" }).lines).toEqual([
        { kind: "same", text: "a", number: 1 },
        { kind: "add", text: "X", number: 2 },
        { kind: "same", text: "b", number: 3 },
        { kind: "remove", text: "c", number: 3 },
      ]);
    });
  });

  it("says whether write_file creates or overwrites a file", () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      mkdirSync("src");
      writeFileSync("src/old.txt", "1\n2\n3\n");

      expect(previewToolCall("write_file", { path: "src/new.txt", content: "x\n" }).summary).toBe(
        "src/new.txt (new file, 1 line)",
      );
      expect(previewToolCall("write_file", { path: "src/old.txt", content: "x\ny\n" }).summary).toBe(
        "src/old.txt (overwrites existing file, 3 → 2 lines)",
      );
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows what delete_file removes, and where move_file moves to", () => {
    inTempDir(() => {
      mkdirSync("src/old/deep", { recursive: true });
      writeFileSync("src/a.js", "one\r\ntwo\r\n");
      writeFileSync("src/logo.png", "\0PNG");
      writeFileSync("src/old/b.js", "b\n");
      writeFileSync("src/old/deep/c.js", "c\n");

      expect(previewToolCall("delete_file", { path: "src/a.js" })).toEqual({
        summary: "src/a.js (2 lines)",
        lines: [
          { kind: "remove", text: "one", number: 1 },
          { kind: "remove", text: "two", number: 2 },
        ],
      });
      expect(previewToolCall("delete_file", { path: "src/old" })).toEqual({
        summary: "src/old (a folder with 2 files)",
        lines: [
          { kind: "remove", text: "src/old/b.js" },
          { kind: "remove", text: "src/old/deep/c.js" },
        ],
      });
      expect(previewToolCall("delete_file", { path: "src/logo.png" })).toEqual({ summary: "src/logo.png", lines: [] });
      expect(previewToolCall("delete_file", { path: "src/missing.js" })).toEqual({ summary: "src/missing.js", lines: [] });

      expect(previewToolCall("move_file", { from: "src/a.js", to: "lib/a.js" })).toEqual({ summary: "src/a.js → lib/a.js", lines: [] });
      expect(previewToolCall("move_file", { from: "src/old", to: "lib/old" }).summary).toBe("src/old → lib/old (a folder with 2 files)");
    });
  });

  it("caps the files shown for a folder to delete", () => {
    inTempDir(() => {
      mkdirSync("logs");
      for (let i = 10; i < 25; i++) writeFileSync(`logs/${i}.log`, "");

      const { summary, lines } = previewToolCall("delete_file", { path: "logs" });
      expect(summary).toBe("logs (a folder with 15 files)");
      expect(lines).toHaveLength(13);
      expect(lines[0]).toEqual({ kind: "remove", text: "logs/10.log" });
      expect(lines.at(-1)).toEqual({ kind: "note", text: "… 3 more files" });
    });
  });

  it("numbers appended lines after the file's last line", () => {
    inTempDir(() => {
      writeFileSync("log.txt", "one\ntwo\n");
      expect(previewToolCall("append_file", { path: "log.txt", content: "three\n" }).lines).toEqual([{ kind: "add", text: "three", number: 3 }]);
      expect(previewToolCall("append_file", { path: "new.txt", content: "first\n" }).lines).toEqual([{ kind: "add", text: "first", number: 1 }]);
    });
  });

  it("summarises appends and assets", () => {
    expect(previewToolCall("append_file", { path: "logs/out.txt", content: "a\nb" }).summary).toBe("logs/out.txt (+2 lines)");
    expect(previewToolCall("write_asset", { path: "notes/x.md", content: "" })).toEqual({
      summary: ".agent/assets/notes/x.md (0 lines)",
      lines: [],
    });
  });

  it("says why reading a file that may hold secrets asks first", () => {
    const note = [{ kind: "note", text: "It may hold secrets, like API keys, and what the model reads goes to its provider." }];
    expect(previewToolCall("read_file", { path: ".env" })).toEqual({ summary: ".env", lines: note });
    expect(previewToolCall("grep", { pattern: "KEY", path: "deploy/.env.local" }).lines).toEqual(note);
    expect(previewToolCall("read_file", { path: ".env.example" }).lines).toEqual([]);
  });

  it("caps long previews", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const { lines } = previewToolCall("write_asset", { path: "x.txt", content });

    expect(lines).toHaveLength(13);
    expect(lines.at(-1)).toEqual({ kind: "note", text: "… 8 more lines" });
    expect(previewToolCall("write_asset", { path: "x.txt", content: "y".repeat(500) }).lines[0].text).toHaveLength(201);
  });

  it("summarises other tools in one readable line", () => {
    const summary = (name, args) => previewToolCall(name, args).summary;

    expect(previewToolCall("shell", { cmd: "npm test" })).toEqual({ summary: "npm test", lines: [] });
    expect(summary("shell", { cmd: "npm ci", timeout: 9999 })).toBe("npm ci (timeout 600s)");
    expect(summary("shell", { cmd: "npm run dev", background: true })).toBe("npm run dev (in the background)");
    expect(summary("process_output", { id: 2 })).toBe("process 2");
    expect(summary("process_output", { id: 2, wait: 10 })).toBe("process 2 (waits up to 10s)");
    expect(summary("stop_process", { id: 2 })).toBe("process 2");
    expect(summary("view_image", { path: "docs/ui.png" })).toBe("docs/ui.png");
    expect(summary("fetch_url", { url: "https://example.com/docs" })).toBe("https://example.com/docs");
    expect(summary("fetch_url", { url: "https://example.com/docs", start: 9000 })).toBe("https://example.com/docs (from character 9000)");
    expect(summary("read_file", { path: "src/a.js" })).toBe("src/a.js");
    expect(summary("read_file", { path: "src/a.js", start_line: 10, end_line: 20 })).toBe("src/a.js (lines 10-20)");
    expect(summary("read_file", { path: "src/a.js", start_line: 10 })).toBe("src/a.js (from line 10)");
    expect(summary("list_dir", {})).toBe(".");
    expect(summary("list_dir", { path: "src", recursive: true })).toBe("src (recursive)");
    expect(summary("grep", { pattern: "todo", ignore_case: true })).toBe("/todo/i in .");
    expect(summary("grep", { pattern: "todo", path: "src", glob: "*.js" })).toBe("/todo/ in src (*.js)");
    expect(summary("find_files", { pattern: "**/*.test.js" })).toBe("**/*.test.js");
    expect(summary("find_files", { pattern: "*.md", path: "docs" })).toBe("*.md in docs");
    expect(summary("git", { command: "diff", staged: true, path: "src" })).toBe("diff --staged src");
    expect(summary("git", { command: "log", count: 5 })).toBe("log -n 5");
    expect(summary("mystery", { a: 1 })).toBe('{"a":1}');
  });
});

describe("previewToolResult", () => {
  it("shows why a tool failed", () => {
    expect(previewToolResult("edit_file", { status: "error", content: "error: old_string not found" })).toEqual([
      { kind: "error", text: "old_string not found" },
    ]);
    // Only the first line, without the colon that introduces what follows for the model.
    const hint = "error: old_string not found, but line 2 matches it apart from spaces and tabs:\n\treturn 1;\nCopy that text exactly into old_string.";
    expect(previewToolResult("edit_file", { status: "error", content: hint })).toEqual([
      { kind: "error", text: "old_string not found, but line 2 matches it apart from spaces and tabs" },
    ]);
  });

  it("leaves out blank lines around a command's output", () => {
    expect(previewToolResult("shell", { status: "ok", content: "\n\n> test\n\nok\n\n" })).toEqual([
      { kind: "output", text: "> test" },
      { kind: "output", text: "" },
      { kind: "output", text: "ok" },
    ]);
  });

  it("leaves other results, and skipped or cancelled calls, to the model", () => {
    expect(previewToolResult("read_file", { status: "ok", content: "file text" })).toEqual([]);
    expect(previewToolResult("shell", { status: "skipped", content: "skipped by user" })).toEqual([]);
    expect(previewToolResult("shell", { status: "cancelled", content: "out\n[cancelled by user]" })).toEqual([]);
  });

  it("shows the end of shell output and how the command failed", () => {
    const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

    expect(previewToolResult("shell", { status: "ok", content: [...output, "[exit code 1]"].join("\n") })).toEqual([
      { kind: "output", text: "… 2 earlier lines" },
      ...output.slice(2).map((text) => ({ kind: "output", text })),
      { kind: "error", text: "exit code 1" },
    ]);
    // Real results have a blank line between output that ends in a newline and the status.
    expect(previewToolResult("shell", { status: "ok", content: "1 failed\n\n[exit code 1]" })).toEqual([
      { kind: "output", text: "1 failed" },
      { kind: "error", text: "exit code 1" },
    ]);
    expect(previewToolResult("shell", { status: "ok", content: "[timed out after 5s]" })).toEqual([
      { kind: "error", text: "timed out after 5s" },
    ]);
    expect(previewToolResult("shell", { status: "ok", content: "[error] spawn cmd.exe ENOENT" })).toEqual([
      { kind: "error", text: "spawn cmd.exe ENOENT" },
    ]);
  });

  it("shows which page fetch_url fetched", () => {
    expect(previewToolResult("fetch_url", { status: "ok", content: "Title: Fetch API | MDN\n\n# Fetch API" })).toEqual([{ kind: "note", text: "Fetch API | MDN" }]);
    expect(previewToolResult("fetch_url", { status: "ok", content: '{"ok":true}' })).toEqual([]);
  });

  it("shows the output of background processes, and how they are doing", () => {
    const started = "Started process 2 in the background.\n> vite\nready in 300 ms\n[process 2 is running]";
    expect(previewToolResult("shell", { status: "ok", content: started })).toEqual([
      { kind: "output", text: "> vite" },
      { kind: "output", text: "ready in 300 ms" },
      { kind: "note", text: "process 2 is running" },
    ]);
    expect(previewToolResult("process_output", { status: "ok", content: "(no new output)\n[process 2 is running]" })).toEqual([
      { kind: "note", text: "process 2 is running" },
    ]);
    expect(previewToolResult("process_output", { status: "ok", content: "done\n[process 2 exited with code 0]" })).toEqual([
      { kind: "output", text: "done" },
      { kind: "note", text: "process 2 exited with code 0" },
    ]);
    expect(previewToolResult("stop_process", { status: "ok", content: "(no new output)\n[process 2 was stopped]" })).toEqual([
      { kind: "note", text: "process 2 was stopped" },
    ]);
    // Failures look like a failed command's.
    expect(previewToolResult("process_output", { status: "ok", content: "EADDRINUSE\n[process 2 exited with code 1]" }).at(-1)).toEqual({
      kind: "error",
      text: "process 2 exited with code 1",
    });
    expect(previewToolResult("shell", { status: "ok", content: "Started process 3 in the background.\n(no new output)\n[process 3 couldn't start: spawn ENOENT]" })).toEqual([
      { kind: "error", text: "process 3 couldn't start: spawn ENOENT" },
    ]);
  });

  it("shows shell lines as a terminal would", () => {
    // Progress bars redraw a line with \r; Windows commands end lines with \r\n.
    expect(previewToolResult("shell", { status: "ok", content: "10%\r50%\r100%\r\ndone\r\n" })).toEqual([
      { kind: "output", text: "100%" },
      { kind: "output", text: "done" },
    ]);
    // Only the last line can be the status, so output that looks like one is left alone.
    expect(previewToolResult("shell", { status: "ok", content: "[error] from the program\nok" })).toEqual([
      { kind: "output", text: "[error] from the program" },
      { kind: "output", text: "ok" },
    ]);
  });
});
