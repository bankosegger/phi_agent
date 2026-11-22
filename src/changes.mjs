import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

// The file's bytes, or null if it does not exist.
function snapshot(fullPath) {
  return existsSync(fullPath) ? readFileSync(fullPath) : null;
}

function same(a, b) {
  return a === null || b === null ? a === b : a.equals(b);
}

// The top folder that writing fullPath will create, or null if its folder exists.
function firstMissingFolder(fullPath) {
  let missing = null;
  for (let dir = dirname(fullPath); !existsSync(dir); dir = dirname(dir)) missing = dir;
  return missing;
}

// Removes `dir` and the folders above it, up to `top`, while they are empty.
function removeEmptyFolders(dir, top) {
  if (!top) return;
  for (;;) {
    try {
      rmdirSync(dir);
    } catch {
      return; // not empty
    }
    if (dir === top) return;
    dir = dirname(dir);
  }
}

/**
 * Remembers what files held before the agent's file tools changed them, so the changes can be
 * undone. Changes made by shell commands are not tracked.
 */
export class FileChanges {
  #files = new Map(); // full path -> { path, before, after, createdFolder }

  // Runs write(), which changes the files at fullPaths (one full path, or several, as for a
  // move), after noting what they held.
  track(fullPaths, write) {
    const paths = [fullPaths].flat();
    for (const fullPath of paths) {
      if (this.#files.has(fullPath)) continue;
      this.#files.set(fullPath, {
        path: relative(process.cwd(), fullPath).replaceAll("\\", "/"),
        before: snapshot(fullPath),
        createdFolder: firstMissingFolder(fullPath),
      });
    }
    try {
      return write();
    } finally {
      for (const fullPath of paths) this.#files.get(fullPath).after = snapshot(fullPath);
    }
  }

  // Project-relative paths of the files that now differ from before.
  get paths() {
    return [...this.#files.values()].filter((file) => !same(file.before, file.after)).map((file) => file.path);
  }

  /**
   * Puts the changed files back, newest change first: restores what a file held (a deleted or
   * moved file comes back where it was), or deletes it (and any folders made for it) if the
   * agent created it. A file that changed again since, by the user or a shell command, is kept
   * as it is. Returns [{ path, action: "restored" | "deleted" | "kept" }].
   */
  undo() {
    const results = [];
    for (const [fullPath, file] of [...this.#files].reverse()) {
      if (same(file.before, file.after)) continue;

      if (!same(snapshot(fullPath), file.after)) {
        results.push({ path: file.path, action: "kept" });
      } else if (file.before === null) {
        rmSync(fullPath, { force: true });
        removeEmptyFolders(dirname(fullPath), file.createdFolder);
        results.push({ path: file.path, action: "deleted" });
      } else {
        // Deleting or moving the file may have removed its folder too.
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, file.before);
        results.push({ path: file.path, action: "restored" });
      }
    }
    this.#files.clear();
    return results.reverse();
  }
}
