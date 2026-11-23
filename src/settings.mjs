import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USER_DIR } from "./agent-core.mjs";
import { EFFORTS } from "./claude.mjs";
import { tools } from "./tools.mjs";

// Settings in JSON files: the user's own, for all their projects, in ~/.phi-agent/settings.json,
// and a project's in its .phi-agent/settings.json, which git can share:
//
//   { "model": "claude-opus-5-5", "effort": "high", "maxToolRounds": 40, "sandbox": true }
//
// The project's win over the user's, and both over .env; command-line options win over all.
// Anyone can commit a project's settings, so they can't loosen what the user decided: only the
// user's own file can allow tool calls without asking ("allow"), and "sandbox": false doesn't
// turn off a sandbox asked for anywhere else.

export const SETTINGS_FILE = "settings.json";

const TOOL_NAMES = new Set(tools.map((tool) => tool.function.name));

// A permission rule (see permissions.mjs) as it is matched, like "shell: npm test" from
// "shell:npm  test", as { rule }, or { problem } saying why it can't be one.
function parseRule(text) {
  const [, tool, scope] = text.trim().match(/^([^:]*?)\s*(?::\s*(.*))?$/s);
  if (!TOOL_NAMES.has(tool)) return { problem: `"${text}" isn't a rule: it starts with a tool's name, like "shell: npm test" or "edit_file"` };
  const words = scope?.trim().split(/\s+/).filter(Boolean).join(" ");
  if (tool === "shell" && !words) return { problem: `"${text}" needs the start of a command, like "shell: npm test"` };
  if (tool === "fetch_url" && !words) return { problem: `"${text}" needs a site, like "fetch_url: docs.python.org"` };
  return { rule: words ? `${tool}: ${words}` : tool };
}

// What each setting takes. `userOnly` ones only count in the user's own file.
const SETTINGS = {
  model: { what: "a model ID, like claude-opus-5-5", check: (value) => typeof value === "string" && /^\S+$/.test(value) },
  effort: { what: `one of ${EFFORTS.join(", ")}`, check: (value) => EFFORTS.includes(value) },
  maxToolRounds: { what: "a whole number from 1 up", check: (value) => Number.isInteger(value) && value >= 1 },
  sandbox: { what: "true or false", check: (value) => typeof value === "boolean" },
  bell: { what: "true or false", check: (value) => typeof value === "boolean" },
  allow: {
    what: 'a list of rules, like ["shell: npm test", "edit_file"]',
    check: (value) => Array.isArray(value) && value.every((rule) => typeof rule === "string"),
    userOnly: true,
  },
};

/**
 * Reads a settings file: { found, settings, problems }. What it can't take is left out of
 * `settings`, with a problem saying why. A missing file is not `found`, and has no problems.
 * Only the user's own file (`user`) can have "allow".
 */
export function readSettingsFile(file, { user = false } = {}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { found: false, settings: {}, problems: [] };
    return { found: true, settings: {}, problems: [`couldn't be read: ${error.message}`] };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { found: true, settings: {}, problems: [`isn't valid JSON, so it isn't used: ${error.message}`] };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { found: true, settings: {}, problems: ['should hold an object, like { "model": "claude-opus-5-5" }'] };
  }

  const settings = {};
  const problems = [];
  for (const [key, value] of Object.entries(data)) {
    const setting = SETTINGS[key];
    if (!setting) {
      problems.push(`"${key}" isn't a setting; there are ${Object.keys(SETTINGS).join(", ")}`);
    } else if (setting.userOnly && !user) {
      problems.push(`"${key}" only counts in your own ~/${USER_DIR}/${SETTINGS_FILE}: a project's settings can't allow tool calls`);
    } else if (!setting.check(value)) {
      problems.push(`"${key}" should be ${setting.what}`);
    } else if (key === "allow") {
      settings.allow = [];
      for (const text of value) {
        const { rule, problem } = parseRule(text);
        if (problem) problems.push(problem);
        else settings.allow.push(rule);
      }
    } else {
      settings[key] = value;
    }
  }
  return { found: true, settings, problems };
}

/**
 * The settings for the project in `cwd`: the user's own, with the project's over them. Returns
 * { settings, from, files, problems }: `from` is the file each setting came from, as the user
 * knows it (".phi-agent/settings.json", "~/.phi-agent/settings.json"), `files` the settings
 * files there are, and each problem starts with its file. `settings.sandbox` is true if either
 * file asks for the sandbox.
 */
export function loadSettings({ cwd = process.cwd(), home = homedir() } = {}) {
  const userFile = join(home, USER_DIR, SETTINGS_FILE);
  const projectFile = join(cwd, USER_DIR, SETTINGS_FILE);
  const none = { found: false, settings: {}, problems: [] };
  const sources = [
    // In the home folder, the project's file is the user's own.
    [`${USER_DIR}/${SETTINGS_FILE}`, projectFile === userFile ? none : readSettingsFile(projectFile)],
    [`~/${USER_DIR}/${SETTINGS_FILE}`, readSettingsFile(userFile, { user: true })],
  ];
  const [project, user] = sources.map(([, read]) => read.settings);
  const settings = { ...user, ...project };
  const from = {};
  for (const [shown, read] of [...sources].reverse()) {
    for (const key of Object.keys(read.settings)) from[key] = shown;
  }
  // Only a file that asks for the sandbox counts for it.
  if (project.sandbox) from.sandbox = sources[0][0];
  else if (user.sandbox) from.sandbox = sources[1][0];
  if (user.sandbox || project.sandbox) settings.sandbox = true;
  else {
    delete settings.sandbox;
    delete from.sandbox;
  }
  return {
    settings,
    from,
    files: sources.filter(([, read]) => read.found).map(([shown]) => shown),
    problems: sources.flatMap(([shown, read]) => read.problems.map((problem) => `${shown}: ${problem}`)),
  };
}
