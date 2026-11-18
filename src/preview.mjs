import { existsSync, readFileSync } from "node:fs";
import { safeProjectPath } from "./tools.mjs";

const MAX_PREVIEW_LINES = 12;
const MAX_PREVIEW_WIDTH = 200;

function splitLines(text) {
  const lines = String(text ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop(); // a trailing newline does not start another line
  return lines;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function previewLines(lines, kind) {
  const shown = lines.slice(0, MAX_PREVIEW_LINES).map((line) => ({
    kind,
    text: line.length > MAX_PREVIEW_WIDTH ? `${line.slice(0, MAX_PREVIEW_WIDTH)}…` : line,
  }));
  if (lines.length > MAX_PREVIEW_LINES) {
    shown.push({ kind: "note", text: `… ${plural(lines.length - MAX_PREVIEW_LINES, "more line")}` });
  }
  return shown;
}

// Line count of an existing project file, or null if it does not exist (or the path is invalid).
function existingLineCount(path) {
  try {
    const fullPath = safeProjectPath(path);
    return existsSync(fullPath) ? splitLines(readFileSync(fullPath, "utf8")).length : null;
  } catch {
    return null;
  }
}

/**
 * Describes a tool call for the user before it runs: a one-line summary, plus diff-style
 * lines ({ kind: "add" | "remove" | "note", text }) for tools that change files.
 */
export function previewToolCall(name, args) {
  if (name === "shell") {
    return { summary: String(args.cmd), lines: [] };
  }

  if (name === "edit_file") {
    return {
      summary: args.path,
      lines: [...previewLines(splitLines(args.old_string), "remove"), ...previewLines(splitLines(args.new_string), "add")],
    };
  }

  if (name === "write_file" || name === "append_file" || name === "write_asset") {
    const lines = splitLines(args.content);
    let detail = plural(lines.length, "line");

    if (name === "append_file") detail = `+${detail}`;
    if (name === "write_file") {
      const existing = existingLineCount(args.path);
      detail = existing == null ? `new file, ${detail}` : `overwrites existing file, ${existing} → ${detail}`;
    }

    const shown = name === "write_asset" ? `.agent/assets/${args.path}` : args.path;
    return { summary: `${shown} (${detail})`, lines: previewLines(lines, "add") };
  }

  return { summary: JSON.stringify(args), lines: [] };
}
