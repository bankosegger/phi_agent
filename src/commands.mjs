import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { USER_DIR } from "./agent-core.mjs";

// Your own slash commands: a prompt in a Markdown file, which /name runs as a task. A project's
// commands are in its .phi-agent/commands folder, which git can share; your own, for all your
// projects, are in ~/.phi-agent/commands. Where both have one of the same name, the project's
// wins. A file can start with a description for /help, what to write after the command, and
// the model to run the command with, if not the one in use:
//
//   ---
//   description: Review the changes for bugs
//   argument-hint: <file>
//   model: claude-opus-5-5
//   ---
//   Review the uncommitted changes ...
//
// $ARGUMENTS in the prompt stands for what follows the command, as in /review src/app.js.
// Without it, what follows goes after the prompt.

export const COMMANDS_FOLDER = "commands";
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_DESCRIPTION = 60;
const MAX_ARGUMENT_HINT = 30;

// The front matter's "name: value" lines, as { name: value }, names in lower case and values
// without the quotes around them.
function frontMatterFields(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const field = line.match(/^([a-z][\w-]*)\s*:\s*(.*?)\s*$/i);
    if (field) fields[field[1].toLowerCase()] = field[2].replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return fields;
}

/**
 * The command a file holds: its prompt, its description (or else its first line), the model to
 * run it with (or null for the one in use), and its `argumentHint`, what to write after it, like
 * "<file>", or null.
 */
export function parseCommand(text) {
  let body = text.replaceAll("\r\n", "\n");
  let fields = {};
  const front = body.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (front) {
    body = body.slice(front[0].length);
    fields = frontMatterFields(front[1]);
  }
  const prompt = body.trim();
  let description = fields.description || null;
  if (!description) {
    const first = prompt.split("\n").find((line) => line.trim()) ?? "";
    description = first.replace(/^#+\s+/, "").trim();
  }
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  // A model ID has no spaces: "model: the fast one" isn't one.
  const model = /^\S+$/.test(fields.model ?? "") ? fields.model : null;
  let argumentHint = fields["argument-hint"] || null;
  if (argumentHint?.length > MAX_ARGUMENT_HINT) argumentHint = `${argumentHint.slice(0, MAX_ARGUMENT_HINT - 1)}…`;
  return { prompt, description, model, argumentHint };
}

/**
 * The commands there are, as a Map from name (without the slash) to { name, prompt, description,
 * model, argumentHint, scope ("project" or "user"), file }. Names come from the file names, in
 * lower case. Also returns `skipped`: the .md files that aren't commands, each with its file and
 * why — a name that isn't a command name (like "my notes.md"), the name of one of `builtIn`, no
 * prompt in it, or another scope's file of the same name winning.
 */
export function loadCommands({ cwd = process.cwd(), home = homedir(), builtIn = [] } = {}) {
  const commands = new Map();
  const skipped = [];
  const taken = new Set(builtIn.map((name) => name.replace(/^\//, "")));
  for (const [scope, dir] of [
    ["user", join(home, USER_DIR, COMMANDS_FOLDER)],
    ["project", join(cwd, USER_DIR, COMMANDS_FOLDER)],
  ]) {
    let files;
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // no such folder
    }
    for (const entry of files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const name = entry.name.replace(/\.md$/i, "").toLowerCase();
      const file = join(dir, entry.name);
      if (!NAME.test(name)) {
        skipped.push({ name, scope, file, reason: "not a command name (a letter or digit, then letters, digits, - or _)" });
        continue;
      }
      if (taken.has(name)) {
        skipped.push({ name, scope, file, reason: `/${name} is a built-in command` });
        continue;
      }
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { prompt, description, model, argumentHint } = parseCommand(text);
      if (!prompt) {
        skipped.push({ name, scope, file, reason: "no prompt in it" });
        continue;
      }
      const existing = commands.get(name);
      if (existing) skipped.push({ name, scope: existing.scope, file: existing.file, reason: `the ${scope}'s ${name}.md wins` });
      commands.set(name, { name, prompt, description, model, argumentHint, scope, file });
    }
  }
  return { commands, skipped };
}

/** The task a command runs, given what followed it: `args` in place of $ARGUMENTS, or after the prompt. */
export function commandTask(command, args = "") {
  const text = args.trim();
  if (command.prompt.includes("$ARGUMENTS")) return command.prompt.replaceAll("$ARGUMENTS", text);
  return text ? `${command.prompt}\n\n${text}` : command.prompt;
}

/** Where a command's file is, as the user knows it: .phi-agent/commands/<name>.md, or with ~/ for your own. */
export function commandPath({ scope, file }) {
  return `${scope === "user" ? `~/${USER_DIR}` : USER_DIR}/${COMMANDS_FOLDER}/${basename(file)}`;
}

/** Whether a message starts like a command: "/help", "/review src/app.js". "/src/app.js" is a path. */
export function isCommandLine(line) {
  return /^\/[a-z0-9][\w-]*(\s|$)/i.test(line);
}

/**
 * The command a message runs, if it starts with the name of one of `commands`, like
 * "/review src/app.js": { command, args }, or null.
 */
export function findCommand(text, commands) {
  const match = String(text).match(/^\/([a-z0-9][\w-]*)(?:\s+([\s\S]*))?$/i);
  const command = match && commands.get(match[1].toLowerCase());
  return command ? { command, args: match[2] ?? "" } : null;
}

// The edit distance between two strings: how many single-character changes turn one into the other.
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = here;
    }
  }
  return row[b.length];
}

/**
 * The name in `names` closest to what the user typed, when it's close enough to be what they
 * meant: within two edits, or one starting with the other ("rev" for "review"). Null when none.
 */
export function nearCommand(typed, names) {
  const text = String(typed).toLowerCase();
  if (!text) return null;
  let best = null;
  let bestScore = Infinity;
  for (const name of names) {
    const other = String(name).toLowerCase();
    // One starting with the other counts as close, whatever the edit distance ("rev"/"review").
    const score = other.startsWith(text) || text.startsWith(other) ? 0 : editDistance(text, other);
    if (score < bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best != null && bestScore <= 2 ? best : null;
}
