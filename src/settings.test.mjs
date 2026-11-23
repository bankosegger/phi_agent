import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allows } from "./permissions.mjs";
import { loadSettings, readSettingsFile } from "./settings.mjs";

// A project folder and a home folder, each with this text (or object, as JSON) in .phi-agent/settings.json.
function folders({ project, home }) {
  const root = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  for (const [where, content] of [
    ["project", project],
    ["home", home],
  ]) {
    mkdirSync(join(root, where, ".phi-agent"), { recursive: true });
    if (content !== undefined) {
      writeFileSync(join(root, where, ".phi-agent", "settings.json"), typeof content === "string" ? content : JSON.stringify(content));
    }
  }
  return { cwd: join(root, "project"), home: join(root, "home"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withFolders(files, fn) {
  const { cwd, home, cleanup } = folders(files);
  try {
    return fn({ cwd, home });
  } finally {
    cleanup();
  }
}

describe("loadSettings", () => {
  it("has none without settings files", () => {
    withFolders({}, ({ cwd, home }) => {
      expect(loadSettings({ cwd, home })).toEqual({ settings: {}, from: {}, files: [], problems: [] });
    });
  });

  it("puts the project's settings over the user's own", () => {
    withFolders(
      {
        project: { model: "claude-opus-5-5", maxToolRounds: 40 },
        home: { model: "openai/gpt-4o-mini", effort: "high", bell: false, allow: ["shell: npm test", " edit_file "] },
      },
      ({ cwd, home }) => {
        const { settings, from, files, problems } = loadSettings({ cwd, home });
        expect(settings).toEqual({ model: "claude-opus-5-5", effort: "high", maxToolRounds: 40, bell: false, allow: ["shell: npm test", "edit_file"] });
        expect(from).toEqual({
          model: ".phi-agent/settings.json",
          maxToolRounds: ".phi-agent/settings.json",
          effort: "~/.phi-agent/settings.json",
          bell: "~/.phi-agent/settings.json",
          allow: "~/.phi-agent/settings.json",
        });
        expect(files).toEqual([".phi-agent/settings.json", "~/.phi-agent/settings.json"]);
        expect(problems).toEqual([]);
      },
    );
  });

  it("only lets the user's own file allow tool calls", () => {
    withFolders({ project: { allow: ["shell: curl"], model: "openai/gpt-5-mini" } }, ({ cwd, home }) => {
      const { settings, problems } = loadSettings({ cwd, home });
      expect(settings).toEqual({ model: "openai/gpt-5-mini" });
      expect(problems).toEqual([`.phi-agent/settings.json: "allow" only counts in your own ~/.phi-agent/settings.json: a project's settings can't allow tool calls`]);
    });
  });

  it("asks for the sandbox if either file does, and a project can't turn it off", () => {
    withFolders({ project: { sandbox: false }, home: { sandbox: true } }, ({ cwd, home }) => {
      expect(loadSettings({ cwd, home })).toMatchObject({ settings: { sandbox: true }, from: { sandbox: "~/.phi-agent/settings.json" } });
    });
    withFolders({ project: { sandbox: true }, home: { sandbox: false } }, ({ cwd, home }) => {
      expect(loadSettings({ cwd, home })).toMatchObject({ settings: { sandbox: true }, from: { sandbox: ".phi-agent/settings.json" } });
    });
    withFolders({ project: { sandbox: false } }, ({ cwd, home }) => {
      expect(loadSettings({ cwd, home })).toMatchObject({ settings: {}, from: {} });
    });
  });

  it("says what is wrong in a file, and uses the rest of it", () => {
    withFolders(
      {
        project: { model: "two words", effort: "extreme", maxToolRounds: 2.5, theme: "dark", sandbox: "yes", bell: true },
        home: { allow: ["shell", "fetch_url: ", "rm_rf: /", "shell:npm  test", "fetch_url : docs.python.org"] },
      },
      ({ cwd, home }) => {
        const { settings, problems } = loadSettings({ cwd, home });
        // Rules are written as they are matched: "tool: what", words one space apart.
        expect(settings).toEqual({ bell: true, allow: ["shell: npm test", "fetch_url: docs.python.org"] });
        expect(problems).toEqual([
          '.phi-agent/settings.json: "model" should be a model ID, like claude-opus-5-5',
          '.phi-agent/settings.json: "effort" should be one of low, medium, high, xhigh, max',
          '.phi-agent/settings.json: "maxToolRounds" should be a whole number from 1 up',
          '.phi-agent/settings.json: "theme" isn\'t a setting; there are model, effort, maxToolRounds, sandbox, bell, allow',
          '.phi-agent/settings.json: "sandbox" should be true or false',
          '~/.phi-agent/settings.json: "shell" needs the start of a command, like "shell: npm test"',
          '~/.phi-agent/settings.json: "fetch_url: " needs a site, like "fetch_url: docs.python.org"',
          '~/.phi-agent/settings.json: "rm_rf: /" isn\'t a rule: it starts with a tool\'s name, like "shell: npm test" or "edit_file"',
        ]);
      },
    );
  });

  it("gives rules that allow tool calls as the rules saved by answering \"a\" do", () => {
    withFolders({ home: { allow: ["shell:npm  test", "fetch_url:docs.python.org", "edit_file"] } }, ({ cwd, home }) => {
      const rules = loadSettings({ cwd, home }).settings.allow;
      expect(allows(rules, "shell", { cmd: "npm test -- --run" })).toBe(true);
      expect(allows(rules, "shell", { cmd: "npm test && rm -rf ~" })).toBe(false);
      expect(allows(rules, "shell", { cmd: "npm install" })).toBe(false);
      expect(allows(rules, "fetch_url", { url: "https://docs.python.org/3/" })).toBe(true);
      expect(allows(rules, "edit_file", { path: "src/app.js" })).toBe(true);
      expect(allows(rules, "delete_file", { path: "src/app.js" })).toBe(false);
    });
  });

  it("leaves out a file that isn't a JSON object, saying so", () => {
    withFolders({ project: "{ model: 'claude-opus-5-5' }", home: "[1, 2]" }, ({ cwd, home }) => {
      const { settings, files, problems } = loadSettings({ cwd, home });
      expect(settings).toEqual({});
      expect(files).toEqual([".phi-agent/settings.json", "~/.phi-agent/settings.json"]);
      expect(problems[0]).toMatch(/^\.phi-agent\/settings\.json: isn't valid JSON, so it isn't used: /);
      expect(problems[1]).toBe('~/.phi-agent/settings.json: should hold an object, like { "model": "claude-opus-5-5" }');
    });
  });

  it("reads a file saved with a byte order mark, as some Windows editors save them", () => {
    withFolders({ project: '﻿{ "model": "claude-opus-5-5" }' }, ({ cwd, home }) => {
      expect(loadSettings({ cwd, home })).toMatchObject({ settings: { model: "claude-opus-5-5" }, problems: [] });
    });
  });

  it("reads the file once in the home folder, as the user's own", () => {
    withFolders({ home: { allow: ["edit_file"] } }, ({ home }) => {
      expect(loadSettings({ cwd: home, home })).toEqual({ settings: { allow: ["edit_file"] }, from: { allow: "~/.phi-agent/settings.json" }, files: ["~/.phi-agent/settings.json"], problems: [] });
    });
  });
});

describe("readSettingsFile", () => {
  it("finds no file where there is none, or where a folder is in the way", () => {
    expect(readSettingsFile(join(tmpdir(), "no-such-folder", "settings.json"))).toEqual({ found: false, settings: {}, problems: [] });
  });
});
