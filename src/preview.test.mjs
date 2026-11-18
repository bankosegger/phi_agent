import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { previewToolCall } from "./preview.mjs";

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

  it("shows the command for shell and the arguments for other tools", () => {
    expect(previewToolCall("shell", { cmd: "npm test" })).toEqual({ summary: "npm test", lines: [] });
    expect(previewToolCall("read_file", { path: "src/a.js" })).toEqual({ summary: '{"path":"src/a.js"}', lines: [] });
  });
});
