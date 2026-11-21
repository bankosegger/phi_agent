import { existsSync, readFileSync } from "node:fs";
import { safeProjectPath, shellTimeout } from "./tools.mjs";

const MAX_PREVIEW_LINES = 12;
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

// The first MAX_PREVIEW_LINES preview lines, and a note saying how many more there are.
function capped(lines) {
  if (lines.length <= MAX_PREVIEW_LINES) return lines;
  return [...lines.slice(0, MAX_PREVIEW_LINES), { kind: "note", text: `… ${plural(lines.length - MAX_PREVIEW_LINES, "more line")}` }];
}

function previewLines(lines, kind) {
  return capped(lines.map((line) => ({ kind, text: clip(line) })));
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

// The changed lines of a diff with DIFF_CONTEXT unchanged lines around them. A note marks where
// unchanged lines were left out: "@ line N" (in the new text) if `lineNumbers`, else "…".
function changedLines(diff, { lineNumbers }) {
  const changed = diff.map((line) => line.kind !== "same");
  const lines = [];
  let skipped = false;
  let lineNumber = 1;

  for (const [index, line] of diff.entries()) {
    if (changed.slice(Math.max(0, index - DIFF_CONTEXT), index + DIFF_CONTEXT + 1).includes(true)) {
      if (skipped) lines.push({ kind: "note", text: lineNumbers ? `@ line ${lineNumber}` : "…" });
      lines.push({ kind: line.kind, text: clip(line.text) });
      skipped = false;
    } else {
      skipped = true;
    }
    if (line.kind !== "remove") lineNumber++;
  }
  return lines;
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
    const timeout = args.timeout == null ? "" : ` (timeout ${shellTimeout(args.timeout)}s)`;
    return { summary: `${args.cmd}${timeout}`, lines: [] };
  }

  if (name === "read_file") {
    return { summary: `${args.path}${lineRange(args.start_line, args.end_line)}`, lines: [] };
  }

  if (name === "list_dir") {
    return { summary: `${args.path || "."}${args.recursive ? " (recursive)" : ""}`, lines: [] };
  }

  if (name === "find_files") {
    return { summary: `${args.pattern}${args.path ? ` in ${args.path}` : ""}`, lines: [] };
  }

  if (name === "grep") {
    const glob = args.glob ? ` (${args.glob})` : "";
    return { summary: `/${args.pattern}/${args.ignore_case ? "i" : ""} in ${args.path || "."}${glob}`, lines: [] };
  }

  if (name === "git") {
    return { summary: gitSummary(args), lines: [] };
  }

  if (name === "edit_file") {
    const before = splitLines(args.old_string);
    const after = splitLines(args.new_string);
    const diff = diffLines(before, after);
    return {
      summary: args.path,
      lines: diff ? capped(changedLines(diff, { lineNumbers: false })) : [...previewLines(before, "remove"), ...previewLines(after, "add")],
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
    const changes = diff && changedLines(diff, { lineNumbers: true });
    const detail = changes?.length === 0 ? "no changes" : `${before.length} → ${plural(lines.length, "line")}`;
    return {
      summary: `${args.path} (overwrites existing file, ${detail})`,
      lines: changes ? capped(changes) : previewLines(lines, "add"),
    };
  }

  if (name === "append_file" || name === "write_asset") {
    const lines = splitLines(args.content);
    const count = plural(lines.length, "line");
    if (name === "append_file") return { summary: `${args.path} (+${count})`, lines: previewLines(lines, "add") };
    return { summary: `.agent/assets/${args.path} (${count})`, lines: previewLines(lines, "add") };
  }

  return { summary: JSON.stringify(args), lines: [] };
}

// A failed shell result ends with a status line like "[exit code 1]" or "[error] spawn ENOENT"
// (see formatResult in tools.mjs). Returns its text without brackets, or null.
function shellFailure(lastLine) {
  return lastLine.match(/^\[((?:exit code|timed out after) [^\]]+)\]$/)?.[1] ?? lastLine.match(/^\[error\] (.+)$/)?.[1] ?? null;
}

/**
 * Describes how a tool call went, for the user: the error for a failed call, and the end of
 * the output for a shell command ({ kind: "output" | "error", text }). Other results, and
 * skipped or cancelled calls, are left to the model.
 */
export function previewToolResult(name, { status, content }) {
  if (status === "error") return [{ kind: "error", text: clip(splitLines(content.replace(/^error: /, ""))[0] ?? "") }];
  if (status !== "ok" || name !== "shell") return [];

  // Show each line as a terminal would: the text after its last carriage return.
  const lines = splitLines(content.trimEnd()).map((line) => line.split("\r").filter(Boolean).at(-1) ?? "");
  const failure = shellFailure(lines.at(-1) ?? "");
  if (failure) lines.pop();
  while (lines.length && !lines.at(-1).trim()) lines.pop();

  const shown = lines.slice(-MAX_RESULT_LINES).map((line) => ({ kind: "output", text: clip(line) }));
  if (lines.length > MAX_RESULT_LINES) {
    shown.unshift({ kind: "output", text: `… ${plural(lines.length - MAX_RESULT_LINES, "earlier line")}` });
  }
  if (failure) shown.push({ kind: "error", text: failure });
  return shown;
}
