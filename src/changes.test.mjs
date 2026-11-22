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

  it("puts deleted and moved files and folders back", async () => {
    await inTempDir(async () => {
      mkdirSync("src/old", { recursive: true });
      mkdirSync("src/utils/deep", { recursive: true });
      writeFileSync("src/a.js", "a\r\n");
      writeFileSync("src/old/b.bin", Buffer.from([0, 1, 2]));
      writeFileSync("src/utils/c.js", "c\n");
      writeFileSync("src/utils/deep/d.js", "d\n");
      const changes = new FileChanges();

      await runTool("delete_file", { path: "src/old" }, { changes });
      await runTool("move_file", { from: "src/a.js", to: "lib/a.js" }, { changes });
      await runTool("move_file", { from: "src/utils", to: "src/lib" }, { changes });
      await runTool("write_file", { path: "src/lib/c.js", content: "changed\n" }, { changes });
      // A file the task created and then deleted was never there as far as undo is concerned.
      await runTool("write_file", { path: "src/tmp/e.js", content: "e\n" }, { changes });
      await runTool("delete_file", { path: "src/tmp/e.js" }, { changes });

      expect(changes.paths).toEqual(["src/old/b.bin", "src/a.js", "lib/a.js", "src/utils/c.js", "src/utils/deep/d.js", "src/lib/c.js", "src/lib/deep/d.js"]);
      expect(changes.undo()).toEqual([
        { path: "src/old/b.bin", action: "restored" },
        { path: "src/a.js", action: "restored" },
        { path: "lib/a.js", action: "deleted" },
        { path: "src/utils/c.js", action: "restored" },
        { path: "src/utils/deep/d.js", action: "restored" },
        { path: "src/lib/c.js", action: "deleted" },
        { path: "src/lib/deep/d.js", action: "deleted" },
      ]);
      expect(readFileSync("src/old/b.bin")).toEqual(Buffer.from([0, 1, 2]));
      expect(readFileSync("src/a.js", "utf8")).toBe("a\r\n");
      expect(readFileSync("src/utils/c.js", "utf8")).toBe("c\n");
      expect(readFileSync("src/utils/deep/d.js", "utf8")).toBe("d\n");
      // The folders made for the moves are gone again.
      expect(existsSync("lib")).toBe(false);
      expect(existsSync("src/lib")).toBe(false);
      expect(existsSync("src/tmp")).toBe(false);
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
