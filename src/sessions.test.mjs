import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { HISTORY_FILE, SESSIONS_DIR, listSessions, loadHistory, loadSession, newSessionFile, saveHistory, saveSession } from "./sessions.mjs";

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

const conversation = (task) => [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: task },
  { role: "assistant", content: "Done." },
];

describe("sessions", () => {
  it("saves a conversation and loads it again, keeping git out of the folder", async () => {
    await inTempDir(async () => {
      const file = newSessionFile(new Date("2026-11-21T22:10:05.123Z"));
      expect(file.replaceAll("\\", "/")).toBe(`${SESSIONS_DIR}/2026-11-21T22-10-05-123Z.json`);

      saveSession(file, { title: "fix the tests", lastTask: "fix the tests", tasks: 1, created: "2026-11-21T22:10:05.123Z", model: "m", messages: conversation("fix the tests") });
      expect(readFileSync(".agent/.gitignore", "utf8")).toBe("*\n");
      expect(readdirSync(SESSIONS_DIR)).toEqual(["2026-11-21T22-10-05-123Z.json"]); // no temporary file left

      const loaded = loadSession(file);
      expect(loaded).toMatchObject({ version: 1, file, title: "fix the tests", tasks: 1, model: "m", messages: conversation("fix the tests") });
      expect(Number.isNaN(Date.parse(loaded.updated))).toBe(false);
    });
  });

  it("lists conversations by when they were last saved, and keeps the last 30", async () => {
    await inTempDir(async () => {
      const files = [];
      for (let i = 0; i < 32; i++) {
        const file = newSessionFile(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
        saveSession(file, { title: `task ${i}`, tasks: 1, messages: conversation(`task ${i}`) });
        utimesSync(file, 1000 + i, 1000 + i); // saved one second apart
        files.push(file);
      }
      // Saving the oldest again makes it the one used last; then only 30 are kept.
      saveSession(files[0], { title: "task 0", tasks: 2, messages: conversation("task 0") });

      const sessions = listSessions();
      expect(sessions).toHaveLength(30);
      expect(sessions.slice(0, 3).map(({ title }) => title)).toEqual(["task 0", "task 31", "task 30"]);
      expect(sessions[0]).toMatchObject({ file: files[0], tasks: 2, messageCount: 3 });
      expect(sessions[0].messages).toBeUndefined();
      expect(existsSync(files[1])).toBe(false);
      expect(existsSync(files[2])).toBe(false);
      expect(existsSync(files[3])).toBe(true);
    });
  });

  it("keeps the prompt's history, newest first in memory and last in the file", async () => {
    await inTempDir(async () => {
      expect(loadHistory()).toEqual([]);
      saveHistory(["third", "second", "first"]);
      expect(readFileSync(HISTORY_FILE, "utf8")).toBe("first\nsecond\nthird\n");
      expect(loadHistory()).toEqual(["third", "second", "first"]);
      expect(readFileSync(".agent/.gitignore", "utf8")).toBe("*\n");
    });
  });

  it("skips files that aren't saved conversations, and says why one can't be loaded", async () => {
    await inTempDir(async () => {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      writeFileSync(join(SESSIONS_DIR, "broken.json"), "{ not json");
      writeFileSync(join(SESSIONS_DIR, "other.json"), JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
      saveSession(join(SESSIONS_DIR, "good.json"), { title: "good", messages: conversation("good") });

      expect(listSessions().map(({ title }) => title)).toEqual(["good"]);
      expect(() => loadSession(join(SESSIONS_DIR, "broken.json"))).toThrow("couldn't read the saved conversation");
      expect(() => loadSession(join(SESSIONS_DIR, "other.json"))).toThrow("isn't a saved conversation");
      expect(listSessions("missing/folder")).toEqual([]);
    });
  });
});
