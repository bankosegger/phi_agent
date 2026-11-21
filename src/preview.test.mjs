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
    const old = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    expect(previewToolCall("edit_file", { path: "src/a.js", old_string: old, new_string: old.replace("6", "six") }).lines).toEqual([
      { kind: "note", text: "…" },
      { kind: "same", text: "4" },
      { kind: "same", text: "5" },
      { kind: "remove", text: "6" },
      { kind: "add", text: "six" },
      { kind: "same", text: "7" },
    ]);
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
          { kind: "note", text: "@ line 13" },
          { kind: "same", text: "line 13" },
          { kind: "same", text: "line 14" },
          { kind: "remove", text: "line 15" },
          { kind: "add", text: "LINE 15" },
          { kind: "same", text: "line 16" },
          { kind: "same", text: "line 17" },
        ],
      });
      expect(previewToolCall("write_file", { path: "src/old.txt", content: lines.join("\n") })).toEqual({
        summary: "src/old.txt (overwrites existing file, no changes)",
        lines: [],
      });
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

  it("summarises appends and assets", () => {
    expect(previewToolCall("append_file", { path: "logs/out.txt", content: "a\nb" }).summary).toBe("logs/out.txt (+2 lines)");
    expect(previewToolCall("write_asset", { path: "notes/x.md", content: "" })).toEqual({
      summary: ".agent/assets/notes/x.md (0 lines)",
      lines: [],
    });
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
