import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { PLAN_NOTE } from "./agent-core.mjs";
import { HISTORY_FILE, SESSIONS_DIR, deleteSession, listSessions, loadHistory, loadSession, newSessionFile, saveHistory, saveSession, searchSessions } from "./sessions.mjs";

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

  it("numbers the conversations as listed, and deletes one", async () => {
    await inTempDir(async () => {
      for (let i = 0; i < 3; i++) {
        const file = newSessionFile(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
        saveSession(file, { title: `task ${i}`, tasks: 1, messages: conversation(`task ${i}`) });
        utimesSync(file, 1000 + i, 1000 + i);
      }
      writeFileSync(join(SESSIONS_DIR, "broken.json"), "{ not json"); // gets no number

      const sessions = listSessions();
      expect(sessions.map(({ number, title }) => `${number} ${title}`)).toEqual(["1 task 2", "2 task 1", "3 task 0"]);

      deleteSession(sessions[1].file);
      expect(existsSync(sessions[1].file)).toBe(false);
      expect(listSessions().map(({ number, title }) => `${number} ${title}`)).toEqual(["1 task 2", "2 task 0"]);
      deleteSession(sessions[1].file); // already gone: no error
    });
  });

  it("finds conversations by words from any of their tasks, in any case", async () => {
    await inTempDir(async () => {
      const save = (i, title, messages, lastTask = title) => {
        const file = newSessionFile(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
        saveSession(file, { title, lastTask, tasks: 2, messages });
        utimesSync(file, 1000 + i, 1000 + i);
      };
      save(0, "fix the Parser bug", conversation("fix the Parser bug"));
      save(1, "add a login page", [
        ...conversation("add a login page"),
        { role: "user", content: "now make the parser accept tabs" },
        { role: "assistant", content: "Done." },
      ], "now make the parser accept tabs");
      save(2, "explain the build", [
        { role: "system", content: "You are a coding agent." },
        // What was attached isn't what the user asked: a file that mentions the parser.
        { role: "user", content: [{ type: "text", text: "explain the build" }, { type: "text", text: "@src/parser.js:\nexport function parse() {}" }] },
        { role: "assistant", content: "It uses esbuild." },
        { role: "user", content: `${PLAN_NOTE}\n\nplan the Windows build` },
      ], "plan the Windows build");

      // The newest first, numbered as /resume lists them; the title has it all, so no match shown.
      const parser = searchSessions("PARSER");
      expect(parser.map(({ number, title, match }) => [number, title, match])).toEqual([
        [2, "add a login page", "now make the parser accept tabs"],
        [3, "fix the Parser bug", null],
      ]);
      expect(parser[0].messages).toBeUndefined();
      expect(parser[0].messageCount).toBe(5);

      // Every word must be in it, though not in the same task; the match has the most of them.
      expect(searchSessions("login tabs").map(({ title, match }) => [title, match])).toEqual([["add a login page", "now make the parser accept tabs"]]);
      expect(searchSessions("login windows")).toEqual([]);
      // Plan mode's note to the model isn't something the user asked.
      expect(searchSessions("windows").map(({ match }) => match)).toEqual(["plan the Windows build"]);
      expect(searchSessions("look around")).toEqual([]);
      // No words: all of them.
      expect(searchSessions("  ")).toHaveLength(3);
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
