import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isSecretFile, safeProjectPath, shellTimeout } from "./tools.mjs";

const MAX_PREVIEW_LINES = 12;
const MAX_COUNTED_FILES = 1000;
const MAX_PREVIEW_WIDTH = 200;
const MAX_RESULT_LINES = 8;
const MAX_DIFF_CELLS = 1_000_000;
const DIFF_CONTEXT = 2;

function splitLines(text) {
  const lines = String(text ?? "").replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop(); // a trailing newline does not start another line
  return lines;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function clip(line) {
  return line.length > MAX_PREVIEW_WIDTH ? `${line.slice(0, MAX_PREVIEW_WIDTH)}…` : line;
}

// Why reading a file asks first, if it may hold secrets.
function secretNote(path) {
  return isSecretFile(path) ? [{ kind: "note", text: "It may hold secrets, like API keys, and what the model reads goes to its provider." }] : [];
}

// The first MAX_PREVIEW_LINES preview lines, and a note saying how many more there are.
function capped(lines) {
  if (lines.length <= MAX_PREVIEW_LINES) return lines;
  return [...lines.slice(0, MAX_PREVIEW_LINES), { kind: "note", text: `… ${plural(lines.length - MAX_PREVIEW_LINES, "more line")}` }];
}

// Lines shown as they are, numbered from `start` (unnumbered if it is null).
function previewLines(lines, kind, start = 1) {
  return capped(lines.map((line, i) => ({ kind, text: clip(line), ...(start != null && { number: start + i }) })));
}

// The text of an existing project file, or null if it does not exist (or the path is invalid).
function existingText(path) {
  try {
    const fullPath = safeProjectPath(path);
    return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : null;
  } catch {
    return null;
  }
}

// The files in a project folder, as project paths, folder by folder: up to MAX_COUNTED_FILES,
// and one more if there are more. Null if `path` isn't a folder.
function folderFiles(path) {
  let pending;
  try {
    const fullPath = safeProjectPath(path);
    if (!lstatSync(fullPath).isDirectory()) return null;
    pending = [fullPath];
  } catch {
    return null;
  }

  const files = [];
  while (pending.length && files.length <= MAX_COUNTED_FILES) {
    const dir = pending.shift();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      // unreadable: its files aren't shown
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else files.push(relative(process.cwd(), entryPath).replaceAll("\\", "/"));
    }
  }
  return files;
}

// "a folder with 12 files", or with "more than 1000 files".
function folderSize(files) {
  return `a folder with ${files.length > MAX_COUNTED_FILES ? `more than ${MAX_COUNTED_FILES} files` : plural(files.length, "file")}`;
}

// The first files of a folder about to be deleted, and a note saying how many more there are.
function deletedFileLines(files) {
  const lines = files.slice(0, MAX_PREVIEW_LINES).map((file) => ({ kind: "remove", text: clip(file) }));
  const more = files.length - lines.length;
  if (more > 0) lines.push({ kind: "note", text: files.length > MAX_COUNTED_FILES ? "… and more" : `… ${plural(more, "more file")}` });
  return lines;
}

/**
 * A line diff that turns `before` into `after`, as [{ kind: "same" | "remove" | "add", text }].
 * Null when the changed parts are too big to compare quickly.
 */
export function diffLines(before, after) {
  // Most changes touch a small part of a file: only the middle that differs needs comparing.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;

  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  if (a.length * b.length > MAX_DIFF_CELLS) return null;

  // common[i][j] is the length of the longest common subsequence of a[i..] and b[j..].
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }

  const diff = before.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      diff.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || common[i + 1][j] >= common[i][j + 1])) {
      diff.push({ kind: "remove", text: a[i++] });
    } else {
      diff.push({ kind: "add", text: b[j++] });
    }
  }
  return [...diff, ...before.slice(before.length - end).map((text) => ({ kind: "same", text }))];
}

// The changed lines of a diff with DIFF_CONTEXT unchanged lines around them, numbered: a removed
// line by its number in the old text, the others by theirs in the new one, counting from
// `start`, the number of the diff's first line (unnumbered if it is null). A { kind: "gap" }
// marks where unchanged lines were left out between changes.
function changedLines(diff, start = 1) {
  const changed = diff.map((line) => line.kind !== "same");
  const lines = [];
  let skipped = false;
  let oldNumber = start;
  let newNumber = start;

  for (const [index, line] of diff.entries()) {
    if (changed.slice(Math.max(0, index - DIFF_CONTEXT), index + DIFF_CONTEXT + 1).includes(true)) {
      if (skipped && lines.length) lines.push({ kind: "gap", text: "" });
      const number = line.kind === "remove" ? oldNumber : newNumber;
      lines.push({ kind: line.kind, text: clip(line.text), ...(start != null && { number }) });
      skipped = false;
    } else {
      skipped = true;
    }
    if (line.kind !== "add") oldNumber++;
    if (line.kind !== "remove") newNumber++;
  }
  return lines;
}

// The number of the line old_string starts on in the file, or null if it isn't there just once.
function editStartLine(path, oldString) {
  const text = existingText(path)?.replaceAll("\r\n", "\n");
  const old = String(oldString ?? "").replaceAll("\r\n", "\n");
  if (text == null || !old) return null;
  const index = text.indexOf(old);
  if (index === -1 || text.indexOf(old, index + old.length) !== -1) return null;
  return text.slice(0, index).split("\n").length;
}

function lineRange(start, end) {
  if (start == null && end == null) return "";
  if (end == null) return ` (from line ${start})`;
  return ` (lines ${start ?? 1}-${end})`;
}

// Reads like the git command it runs, e.g. "diff --staged src".
function gitSummary({ command, path, staged, count }) {
  const options = [command === "diff" && staged && "--staged", command === "log" && count && `-n ${count}`];
  return [command, ...options, path].filter(Boolean).join(" ");
}

/**
 * Describes a tool call for the user before it runs: a one-line summary, plus diff-style
 * lines ({ kind: "add" | "remove" | "same" | "note", text }) for tools that change files.
 * `args` is null when the model's arguments could not be read.
 */
export function previewToolCall(name, args) {
  if (args == null) {
    return { summary: "", lines: [] };
  }

  if (name === "shell") {
    if (args.background) return { summary: `${args.cmd} (in the background)`, lines: [] };
    const timeout = args.timeout == null ? "" : ` (timeout ${shellTimeout(args.timeout)}s)`;
    return { summary: `${args.cmd}${timeout}`, lines: [] };
  }

  if (name === "view_image") {
    return { summary: args.path, lines: [] };
  }

  if (name === "fetch_url") {
    return { summary: `${args.url}${Number(args.start) > 0 ? ` (from character ${args.start})` : ""}`, lines: [] };
  }

  if (name === "web_search") {
    return { summary: String(args.query ?? ""), lines: [] };
  }

  // The to-do list, a step a line, ticked off as the model goes. (It may be malformed: the call
  // shows before it is checked.)
  if (name === "todo_write") {
    const todos = Array.isArray(args.todos) ? args.todos.filter((todo) => todo && typeof todo === "object") : [];
    const done = todos.filter((todo) => todo.status === "completed").length;
    return {
      summary: todos.length ? `${done} of ${todos.length} done` : "cleared",
      lines: todos.map((todo) => ({ kind: "todo", status: todo.status, text: clip(String(todo.content ?? "").trim()) })),
    };
  }

  if (name === "process_output") {
    return { summary: `process ${args.id}${Number(args.wait) > 0 ? ` (waits up to ${args.wait}s)` : ""}`, lines: [] };
  }

  if (name === "stop_process") {
    return { summary: `process ${args.id}`, lines: [] };
  }

  if (name === "read_file") {
    return { summary: `${args.path}${lineRange(args.start_line, args.end_line)}`, lines: secretNote(args.path) };
  }

  if (name === "list_dir") {
    return { summary: `${args.path || "."}${args.recursive ? " (recursive)" : ""}`, lines: [] };
  }

  if (name === "find_files") {
    return { summary: `${args.pattern}${args.path ? ` in ${args.path}` : ""}`, lines: [] };
  }

  if (name === "grep") {
    const glob = args.glob ? ` (${args.glob})` : "";
    return { summary: `/${args.pattern}/${args.ignore_case ? "i" : ""} in ${args.path || "."}${glob}`, lines: secretNote(args.path) };
  }

  if (name === "git") {
    return { summary: gitSummary(args), lines: [] };
  }

  if (name === "edit_file") {
    const before = splitLines(args.old_string);
    const after = splitLines(args.new_string);
    const diff = diffLines(before, after);
    const start = editStartLine(args.path, args.old_string);
    return {
      summary: args.path,
      lines: diff ? capped(changedLines(diff, start)) : [...previewLines(before, "remove", start), ...previewLines(after, "add", start)],
    };
  }

  if (name === "write_file") {
    const lines = splitLines(args.content);
    const existing = existingText(args.path);
    if (existing == null) {
      return { summary: `${args.path} (new file, ${plural(lines.length, "line")})`, lines: previewLines(lines, "add") };
    }

    // For an overwrite, what changes says more than the start of the new content.
    const before = splitLines(existing);
    const diff = diffLines(before, lines);
    const changes = diff && changedLines(diff);
    const detail = changes?.length === 0 ? "no changes" : `${before.length} → ${plural(lines.length, "line")}`;
    return {
      summary: `${args.path} (overwrites existing file, ${detail})`,
      lines: changes ? capped(changes) : previewLines(lines, "add"),
    };
  }

  if (name === "delete_file") {
    // What is about to go: a folder's files, or a text file's first lines.
    const files = folderFiles(args.path);
    if (files) return { summary: `${args.path} (${folderSize(files)})`, lines: deletedFileLines(files) };
    const text = existingText(args.path);
    if (text == null || text.includes("\0")) return { summary: args.path, lines: [] };
    const lines = splitLines(text);
    return { summary: `${args.path} (${plural(lines.length, "line")})`, lines: previewLines(lines, "remove") };
  }

  if (name === "move_file") {
    const files = folderFiles(args.from);
    return { summary: `${args.from} → ${args.to}${files ? ` (${folderSize(files)})` : ""}`, lines: [] };
  }

  if (name === "append_file" || name === "write_asset") {
    const lines = splitLines(args.content);
    const count = plural(lines.length, "line");
    if (name === "append_file") {
      const existing = existingText(args.path);
      const start = existing == null ? 1 : splitLines(existing).length + 1;
      return { summary: `${args.path} (+${count})`, lines: previewLines(lines, "add", start) };
    }
    return { summary: `.agent/assets/${args.path} (${count})`, lines: previewLines(lines, "add") };
  }

  // An MCP server's tool (see mcp.mjs) can do anything, so what it is given shows in full enough
  // to decide on: an argument a line.
  if (/^mcp__/.test(name)) {
    const entries = Object.entries(args);
    const lines = entries.slice(0, MAX_MCP_ARGUMENTS).map(([key, value]) => ({ kind: "note", text: clip(`${key}: ${JSON.stringify(value)}`) }));
    if (entries.length > MAX_MCP_ARGUMENTS) lines.push({ kind: "note", text: `… ${entries.length - MAX_MCP_ARGUMENTS} more` });
    return { summary: "", lines };
  }

  return { summary: JSON.stringify(args), lines: [] };
}

const MAX_MCP_ARGUMENTS = 12;
const MCP_RESULT_LINES = 3;

// The status line a command's output ends with (see formatResult and processStatus in
// tools.mjs), as a preview line: an error for "[exit code 1]", "[timed out after 5s]",
// "[error] spawn ENOENT" or a background process that failed, and a note for one that runs or
// was stopped. Null for other lines.
function statusLine(lastLine) {
  const failure = lastLine.match(/^\[((?:exit code|timed out after) [^\]]+)\]$/)?.[1] ?? lastLine.match(/^\[error\] (.+)$/)?.[1];
  if (failure) return { kind: "error", text: failure };
  const process = lastLine.match(/^\[(process \d+ .+)\]$/)?.[1];
  if (!process) return null;
  return { kind: /exited with (?!code 0$)|couldn't start/.test(process) ? "error" : "note", text: process };
}

// Tools whose result is a command's output, which the user sees the end of.
const OUTPUT_TOOLS = new Set(["shell", "process_output", "stop_process"]);

/**
 * Describes how a tool call went, for the user: the error for a failed call, and the end of
 * the output for a command ({ kind: "output" | "error" | "note", text }). Other results, and
 * skipped or cancelled calls, are left to the model.
 */
export function previewToolResult(name, { status, content }) {
  // An error's first line says what went wrong; what it introduces with a colon is for the model.
  if (status === "error") return [{ kind: "error", text: clip((splitLines(content.replace(/^error: /, ""))[0] ?? "").replace(/:$/, "")) }];
  // A fetched page's title says which page it was.
  if (status === "ok" && name === "fetch_url") {
    const title = content.match(/^Title: (.+)/)?.[1];
    return title ? [{ kind: "note", text: clip(title) }] : [];
  }
  // An MCP server's answer: its first lines.
  if (status === "ok" && /^mcp__/.test(name)) {
    const lines = splitLines(content.trim()).filter((line) => line.trim());
    const shown = lines.slice(0, MCP_RESULT_LINES).map((line) => ({ kind: "output", text: clip(line) }));
    if (lines.length > MCP_RESULT_LINES) shown.push({ kind: "note", text: `… ${lines.length - MCP_RESULT_LINES} more lines` });
    return shown;
  }
  if (status !== "ok" || !OUTPUT_TOOLS.has(name)) return [];

  // Show each line as a terminal would: the text after its last carriage return.
  const lines = splitLines(content.trimEnd()).map((line) => line.split("\r").filter(Boolean).at(-1) ?? "");
  const ending = statusLine(lines.at(-1) ?? "");
  if (ending) lines.pop();
  // The process number is in the status line; "(no new output)" needs no line of its own.
  if (/^Started process \d+ in the background\.$/.test(lines[0] ?? "")) lines.shift();
  if (lines.length === 1 && lines[0] === "(no new output)") lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();

  const shown = lines.slice(-MAX_RESULT_LINES).map((line) => ({ kind: "output", text: clip(line) }));
  if (lines.length > MAX_RESULT_LINES) {
    shown.unshift({ kind: "output", text: `… ${plural(lines.length - MAX_RESULT_LINES, "earlier line")}` });
  }
  if (ending) shown.push(ending);
  return shown;
}
