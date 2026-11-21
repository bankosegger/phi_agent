import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { FileChanges } from "./changes.mjs";
import { runTool } from "./tools.mjs";

async function inTempDir(fn) {
  const originalCwd = cwd();
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  try {
    chdir(dir);
    return await fn(dir);
  } finally {
    chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("FileChanges", () => {
  it("undoes edits, appends and new files, back to the exact bytes", async () => {
    await inTempDir(async () => {
      mkdirSync("src");
      writeFileSync("src/a.js", "one\r\ntwo\r\n");
      writeFileSync("src/same.txt", "same\n");
      const changes = new FileChanges();

      await runTool("edit_file", { path: "src/a.js", old_string: "two", new_string: "2" }, { changes });
      await runTool("append_file", { path: "src/a.js", content: "three\n" }, { changes });
      await runTool("write_file", { path: "src/same.txt", content: "same\n" }, { changes });
      await runTool("write_file", { path: "src/new/deep/b.js", content: "new\n" }, { changes });

      // Writing a file's own content again is not a change.
      expect(changes.paths).toEqual(["src/a.js", "src/new/deep/b.js"]);
      expect(changes.undo()).toEqual([
        { path: "src/a.js", action: "restored" },
        { path: "src/new/deep/b.js", action: "deleted" },
      ]);
      expect(readFileSync("src/a.js", "utf8")).toBe("one\r\ntwo\r\n");
      // The folders made for the new file go too, but not the ones that were there.
      expect(existsSync("src/new")).toBe(false);
      expect(existsSync("src")).toBe(true);
      expect(changes.paths).toEqual([]);
    });
  });

  it("keeps a file that changed again after the agent wrote it", async () => {
    await inTempDir(async () => {
      const changes = new FileChanges();
      await runTool("write_file", { path: "src/a.txt", content: "agent\n" }, { changes });
      writeFileSync("src/a.txt", "user\n");

      expect(changes.undo()).toEqual([{ path: "src/a.txt", action: "kept" }]);
      expect(readFileSync("src/a.txt", "utf8")).toBe("user\n");
    });
  });

  it("only tracks changes that were made", async () => {
    await inTempDir(async () => {
      mkdirSync("src");
      writeFileSync("src/a.txt", "a\n");
      const changes = new FileChanges();

      await expect(runTool("edit_file", { path: "src/a.txt", old_string: "zzz", new_string: "y" }, { changes })).rejects.toThrow("not found");
      await runTool("write_asset", { path: "notes.md", content: "scratch" }, { changes });

      expect(changes.paths).toEqual([]);
      expect(changes.undo()).toEqual([]);
    });
  });
});
