import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { imagePart } from "./images.mjs";
import { backgroundProcesses, killProcessTree, spawnShell } from "./processes.mjs";
import { fetchUrl, webUrl } from "./web.mjs";

const ASSET_DIR = ".agent/assets";
const SHELL_TIMEOUT_DEFAULT = 120; // seconds
const SHELL_TIMEOUT_MAX = 600;
const BACKGROUND_START_WAIT = 3; // seconds to wait for a background command's first output
const MAX_OUTPUT_WAIT = 60;
const GIT_TIMEOUT_MS = 30_000;
const MAX_TOOL_OUTPUT = 10_000;
const MAX_SHELL_CAPTURE = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_FOUND_FILES = 200;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_IGNORED_NAMES = 5;
// delete_file and move_file keep what they change in memory, for /undo.
const MAX_TRACKED_FILES = 1000;
const MAX_TRACKED_MB = 50;
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".agent"]);
const GIT_COMMANDS = ["status", "diff", "log"];
const GIT_LOG_DEFAULT = 20;
const GIT_LOG_MAX = 100;
const SEARCH_IGNORED_FOLDER = "Naming a folder git ignores, like dist, searches it anyway.";

export const tools = [
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run a shell command in the project directory. It gets no input, so interactive prompts fail: pass flags like --yes instead. Long output keeps its start and end.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          timeout: {
            type: "integer",
            description: `Seconds to wait before stopping the command, up to ${SHELL_TIMEOUT_MAX}. Defaults to ${SHELL_TIMEOUT_DEFAULT}; raise it for slow installs, builds or test runs.`,
          },
          background: {
            type: "boolean",
            description:
              "Keep the command running in the background, for a server or a watcher that doesn't exit. Returns its first output after a few seconds; read more with process_output, and stop it with stop_process once you no longer need it.",
          },
        },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process_output",
      description: "Read what a background process printed since you last read it, and whether it is still running.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "The process number that shell gave when it started it" },
          wait: {
            type: "integer",
            description: `Seconds to wait for new output, or for the process to end, up to ${MAX_OUTPUT_WAIT}. Defaults to 0.`,
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_process",
      description: "Stop a background process, and any processes it started. Returns its last output.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git",
      description:
        "Run a read-only git command in the project: status, diff, or log. Optionally limit to a project path. Does not change the repository.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", enum: GIT_COMMANDS },
          path: { type: "string", description: "File or folder to limit the output to. Defaults to the whole project." },
          staged: { type: "boolean", description: "For diff: show staged changes instead of unstaged." },
          count: { type: "integer", description: `For log: number of commits, 1-${GIT_LOG_MAX}. Defaults to ${GIT_LOG_DEFAULT}.` },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file inside the project. Optionally read only a 1-indexed, inclusive line range. Long files are returned in parts that say which line to continue from.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description: "Look at an image file in the project, like a screenshot, a diagram or a design: PNG, JPEG, GIF or WebP, up to 5 MB.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List files and folders in a project directory. Folders end with /. Skips node_modules, .git and .agent; what git ignores is named at the end instead of listed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list. Defaults to the project root." },
          recursive: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Find project files with a glob pattern, like *.test.js, src/**/*.ts or {README,CHANGELOG}.md. A pattern without / matches file names in any folder. Case is ignored. Skips node_modules, .git, .agent and files git ignores.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern: * and ? match within a folder name, ** matches any folders." },
          path: { type: "string", description: `Folder to search. Defaults to the project root. ${SEARCH_IGNORED_FOLDER}` },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search project files for a regular expression. Returns path:line:text matches. Skips node_modules, .git, .agent and files git ignores.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression" },
          path: { type: "string", description: `File or folder to search. Defaults to the project root. ${SEARCH_IGNORED_FOLDER}` },
          glob: { type: "string", description: "Only search files matching this glob pattern, like *.js or src/**/*.ts." },
          ignore_case: { type: "boolean", description: "Match regardless of upper or lower case." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch a web page, or other text, over http or https: documentation, an issue, an API response, or a server you started. HTML comes back as readable text with its links. Long pages come in parts that say where to continue.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          start: { type: "integer", description: "The character to start from, to read the next part of a long page" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact occurrence of old_string with new_string in a file. Fails if old_string is missing or appears more than once, so include enough context to make it unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_file",
      description: "Append text to a file, creating it if needed. New files can't be created at the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a text file, replacing it if it exists. New files can't be created at the project root: put them in a folder like src/. Use write_asset for generated output that isn't project source.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file, or a folder and everything in it. Folders it leaves empty are removed too. The user can undo it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description:
        "Move or rename a file or folder. Fails if the new path exists. Creates the folders the new path needs, and removes those the move leaves empty. The user can undo it.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "The file or folder to move" },
          to: { type: "string", description: "Its new path, including the name, like lib/util.js" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_asset",
      description:
        "Save generated output that isn't project source, like a report, a data export or an SVG, under .agent/assets/, which git ignores. Files are kept after the session; tell the user where you saved them.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative asset path, like notes/output.txt" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
];

/** The tools for a model: without view_image if it can't see images. */
export function toolsFor({ images = true } = {}) {
  return images ? tools : tools.filter((tool) => tool.function.name !== "view_image");
}

export function needsConfirmation(name) {
  return ["shell", "write_file", "write_asset", "edit_file", "append_file", "delete_file", "move_file", "fetch_url"].includes(name);
}

export function safeProjectPath(path) {
  if (!path || isAbsolute(path)) throw new Error("Path must be relative");

  const root = process.cwd();
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path must stay inside the project");
  }

  return fullPath;
}

function safeAssetPath(path) {
  const assetRoot = safeProjectPath(ASSET_DIR);
  if (!path || isAbsolute(path)) throw new Error("Asset path must be relative");

  const fullPath = resolve(assetRoot, path);
  const rel = relative(assetRoot, fullPath);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Asset path must stay inside .agent/assets");
  }

  return fullPath;
}

// Files the file tools may change: not inside .git, and at the project root only files that
// exist already (like package.json), so new files go in folders instead of piling up there.
// A new folder at the root is fine.
function checkWritable(fullPath, { folder = false } = {}) {
  const rel = relative(process.cwd(), fullPath);
  if (rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
    throw new Error("Files inside .git can't be changed.");
  }
  if (!folder && dirname(rel) === "." && !existsSync(fullPath)) {
    throw new Error("New files can't be created at the project root. Put them in a folder like src/, or save generated output with write_asset.");
  }
}

function truncate(text) {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n[truncated ${text.length - MAX_TOOL_OUTPUT} chars]`;
}

// Keeps the start and end of long command output: errors and summaries are usually at the end.
function truncateMiddle(text) {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  const head = Math.floor(MAX_TOOL_OUTPUT * 0.3);
  const tail = MAX_TOOL_OUTPUT - head;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

// "\r\n" or "\n", whichever the text mostly uses; null when it has no line breaks.
function lineEnding(text) {
  const breaks = text.match(/\n/g)?.length ?? 0;
  if (!breaks) return null;
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  return crlf * 2 > breaks ? "\r\n" : "\n";
}

// Models write "\n" even for files checked out with "\r\n" (git's default on Windows).
// Rewriting their line breaks in the file's own style keeps edits matching and files consistent.
function withLineEndings(text, eol) {
  return eol ? text.replace(/\r?\n/g, eol) : text;
}

function existingLineEnding(fullPath) {
  return existsSync(fullPath) ? lineEnding(readFileSync(fullPath, "utf8")) : null;
}

function requireString(args, key) {
  if (typeof args[key] !== "string") throw new Error(`${key} must be a string`);
  return args[key];
}

// Seconds a shell command may run: the requested value within 1-SHELL_TIMEOUT_MAX, or the default.
export function shellTimeout(seconds) {
  return Math.min(Math.max(1, Math.round(Number(seconds)) || SHELL_TIMEOUT_DEFAULT), SHELL_TIMEOUT_MAX);
}

function runShell(cmd, { signal, timeoutMs }) {
  if (signal?.aborted) return formatResult({ stopped: "cancelled" });

  return new Promise((resolvePromise) => {
    const child = spawnShell(cmd);
    const output = { stdout: "", stderr: "" };
    let stopped = null;
    let settled = false;

    for (const name of ["stdout", "stderr"]) {
      child[name].setEncoding("utf8").on("data", (text) => {
        if (output[name].length < MAX_SHELL_CAPTURE) output[name] += text;
      });
    }

    const stop = (reason) => {
      if (stopped) return;
      stopped = reason;
      killProcessTree(child);
      // A process that escaped the kill can hold the output pipes open; stop waiting for it.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ status: child.exitCode, signal: child.signalCode });
      }, 2000).unref();
    };
    const onAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(formatResult({ ...output, ...result, stopped }, timeoutMs));
    };
    child.on("error", (error) => finish({ error }));
    child.on("close", (status, exitSignal) => finish({ status, signal: exitSignal }));
  });
}

// "[process 2 is running]", or how it ended.
function processStatus(proc) {
  if (proc.running) return `[process ${proc.id} is running]`;
  if (proc.stopped) return `[process ${proc.id} was stopped]`;
  if (proc.exit.error) return `[process ${proc.id} couldn't start: ${proc.exit.error.message}]`;
  return `[process ${proc.id} exited with ${proc.exit.code != null ? `code ${proc.exit.code}` : proc.exit.signal}]`;
}

// What a background process printed since the model last read it, and how it is doing.
function processReport(proc) {
  const { text, lost } = proc.read();
  const parts = [];
  if (lost) parts.push(`[${lost} characters of output were dropped before they could be read]`);
  parts.push(text.trim() ? truncateMiddle(text.trimEnd()) : "(no new output)");
  parts.push(processStatus(proc));
  return parts.join("\n");
}

// Starts a command that keeps running, like a dev server, and returns its first output. If the
// task is cancelled meanwhile, the command is stopped again.
async function startInBackground(cmd, signal) {
  if (signal?.aborted) return formatResult({ stopped: "cancelled" });
  const proc = backgroundProcesses.start(cmd);
  await backgroundProcesses.waitForOutput(proc, BACKGROUND_START_WAIT, signal);
  if (signal?.aborted) await proc.stop();
  return `Started process ${proc.id} in the background.\n${processReport(proc)}`;
}

function runGit({ command, path, staged, count }) {
  if (!GIT_COMMANDS.includes(command)) {
    throw new Error(`git command must be one of: ${GIT_COMMANDS.join(", ")}`);
  }

  const argv = [command];
  if (command === "status") argv.push("--short", "--branch");
  if (command === "diff") argv.push("--no-ext-diff", "--no-textconv", ...(staged ? ["--staged"] : []));
  if (command === "log") {
    const max = Math.min(Math.max(1, Number(count) || GIT_LOG_DEFAULT), GIT_LOG_MAX);
    argv.push("--oneline", `--max-count=${max}`);
  }

  // Paths go after "--" so git never reads them as options.
  const rel = path ? relative(process.cwd(), safeProjectPath(path)).replaceAll("\\", "/") : "";
  argv.push("--", rel || ".");

  // No shell: arguments are passed to git as-is. --no-pager stops git waiting on a pager.
  return formatResult(
    spawnSync("git", ["--no-pager", ...argv], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }),
    GIT_TIMEOUT_MS,
  );
}

function formatResult(result, timeoutMs) {
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);

  // The status goes after truncation so the model always sees how the command ended.
  let status = "";
  if (result.stopped === "cancelled") status = "[cancelled by user]";
  else if (result.stopped === "timeout" || result.error?.code === "ETIMEDOUT") status = `[timed out after ${timeoutMs / 1000}s]`;
  else if (result.error) status = `[error] ${result.error.message}`;
  else if (result.status !== 0) status = `[exit code ${result.status ?? result.signal}]`;

  return [truncateMiddle(parts.join("\n")), status].filter(Boolean).join("\n") || "(no output)";
}

function readFile({ path, start_line, end_line }) {
  const text = readFileSync(safeProjectPath(path), "utf8");
  if (text.includes("\0")) {
    const hint = /\.(png|jpe?g|gif|webp)$/i.test(path) ? "; look at images with view_image" : "";
    throw new Error(`${path} looks like a binary file; read_file only reads text${hint}`);
  }

  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop(); // a trailing newline does not start another line
  if (!lines.length) return "(empty file)";

  const from = Math.max(1, start_line ?? 1);
  const to = Math.min(lines.length, end_line ?? lines.length);
  if (from > lines.length) throw new Error(`Line ${from} is outside the file (${lines.length} lines)`);
  if (from > to) throw new Error(`end_line ${end_line} is before start_line ${from}`);

  // Whole lines up to the output limit (at least one), then a note saying where to carry on.
  let last = from - 1;
  let size = 0;
  while (last < to) {
    size += lines[last].length + 1;
    if (size > MAX_TOOL_OUTPUT && last >= from) break;
    last++;
  }

  const shown = truncate(lines.slice(from - 1, last).join("\n"));
  if (last === to) return shown;
  return `${shown}\n[showing lines ${from}-${last} of ${lines.length}; continue with start_line=${last + 1}]`;
}

// A path relative to `base` (the project by default), with "/" separators.
function shownPath(fullPath, base = process.cwd()) {
  return relative(base, fullPath).replaceAll("\\", "/");
}

// What git ignores in the project: relative paths with "/" separators, folders ending in "/".
// A folder that is ignored as a whole is one entry, not its contents. (When the whole project
// is ignored, as in a home folder kept in git with "*" in its .gitignore, that entry is "./",
// which hides nothing.) Null outside a git repository.
function gitIgnoredPaths() {
  const result = spawnSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return result.status === 0 ? new Set(result.stdout.split("\0").filter(Boolean)) : null;
}

// Whether git ignores the folder `path` (project-relative, ending in "/") or a folder it is in.
function insideIgnored(path, ignored) {
  for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
    if (ignored.has(path.slice(0, end + 1))) return true;
  }
  return false;
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Calls visit(fullPath, isDir) for each file and folder in `root`, and below it if `recursive`,
 * in name order. Skips SKIPPED_DIRS and what git ignores, except below a root that git ignores:
 * that was asked for by name. visit can return false to stop the walk.
 * Returns the ignored files and folders it skipped, as { fullPath, isDir }.
 */
function walk(root, visit, { recursive = true } = {}) {
  let ignored = gitIgnoredPaths();
  if (ignored && insideIgnored(`${shownPath(root)}/`, ignored)) ignored = null;
  const skipped = [];

  const visitDir = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === root) throw error;
      return; // a folder below the root that can't be read is skipped, not fatal
    }

    for (const entry of entries.sort(byName)) {
      const isDir = entry.isDirectory();
      if (isDir && SKIPPED_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (ignored?.has(shownPath(fullPath) + (isDir ? "/" : ""))) {
        skipped.push({ fullPath, isDir });
        continue;
      }
      if (visit(fullPath, isDir) === false) return false;
      if (recursive && isDir && visitDir(fullPath) === false) return false;
    }
  };

  visitDir(root);
  return skipped;
}

// "a, b, c and 4 more"
function nameList(names) {
  const shown = names.slice(0, MAX_IGNORED_NAMES).join(", ");
  return names.length > MAX_IGNORED_NAMES ? `${shown} and ${names.length - MAX_IGNORED_NAMES} more` : shown;
}

/**
 * A case-insensitive RegExp for a glob pattern: * and ? match within one folder or file name,
 * ** matches any number of folders, {a,b} matches either, and [abc] matches one character.
 */
export function globToRegExp(glob) {
  let source = "";
  let openBraces = 0;

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const setEnd = char === "[" ? glob.indexOf("]", i + 2) : -1;

    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      source += "(?:";
      openBraces++;
    } else if (char === "}" && openBraces) {
      source += ")";
      openBraces--;
    } else if (char === "," && openBraces) {
      source += "|";
    } else if (setEnd !== -1) {
      const set = glob.slice(i + 1, setEnd);
      source += `[${set.startsWith("!") ? `^${set.slice(1)}` : set}]`;
      i = setEnd;
    } else {
      source += char.replace(/[.+^$()|[\]{}\\]/, "\\$&");
    }
  }

  if (openBraces) throw new Error(`glob pattern ${glob} has an unclosed {`);
  return new RegExp(`^${source}$`, "i");
}

// Tests whether a file matches a glob pattern. A pattern without "/" matches file names. One
// with "/" matches paths from `root`, or from the project root, which models also write.
// A leading "./" or "/" means the same as none.
function globMatcher(pattern, root) {
  const glob = pattern.trim().replaceAll("\\", "/").replace(/^\.?\//, "");
  if (!glob) throw new Error("glob pattern must not be empty");
  const regex = globToRegExp(glob);

  if (!glob.includes("/")) return (fullPath) => regex.test(basename(fullPath));
  return (fullPath) => regex.test(shownPath(fullPath, root)) || regex.test(shownPath(fullPath));
}

function listDir(path, recursive) {
  const root = safeProjectPath(path);
  const shown = ({ fullPath, isDir }) => shownPath(fullPath, root) + (isDir ? "/" : "");
  const entries = [];
  let stopped = false;

  const skipped = walk(
    root,
    (fullPath, isDir) => {
      stopped = entries.length === MAX_LIST_ENTRIES;
      if (stopped) return false;
      entries.push(shown({ fullPath, isDir }));
    },
    { recursive: Boolean(recursive) },
  );

  const notes = [];
  if (stopped) notes.push(`[stopped at ${MAX_LIST_ENTRIES} entries]`);
  if (skipped.length) notes.push(`[ignored by git, not listed: ${nameList(skipped.map(shown))}]`);
  return [entries.sort().join("\n") || "(empty)", ...notes].join("\n");
}

function findFiles(pattern, path) {
  const root = safeProjectPath(path);
  const matches = globMatcher(pattern, root);
  if (!statSync(root).isDirectory()) throw new Error(`${path} is not a folder`);

  const found = [];
  const skipped = walk(root, (fullPath, isDir) => {
    if (!isDir && matches(fullPath)) found.push(shownPath(fullPath));
  });

  if (!found.length) return skipped.length ? "no files found (files git ignores were not searched)" : "no files found";
  const more = found.length - MAX_FOUND_FILES;
  return found.sort().slice(0, MAX_FOUND_FILES).join("\n") + (more > 0 ? `\n[${more} more; narrow the pattern or path]` : "");
}

function grep({ pattern, path, glob, ignoreCase }) {
  const regex = new RegExp(pattern, ignoreCase ? "i" : "");
  const root = safeProjectPath(path);
  const included = glob ? globMatcher(glob, root) : () => true;
  const matches = [];

  const searchFile = (fullPath) => {
    let text;
    try {
      const stats = statSync(fullPath);
      if (!stats.isFile() || stats.size > MAX_GREP_FILE_BYTES) return;
      text = readFileSync(fullPath, "utf8");
    } catch {
      return; // unreadable, like a broken link
    }
    if (text.includes("\0")) return;

    const shown = shownPath(fullPath);
    for (const [i, line] of text.split("\n").entries()) {
      if (!regex.test(line)) continue;
      matches.push(`${shown}:${i + 1}:${line.trimEnd().slice(0, 300)}`);
      if (matches.length >= MAX_GREP_MATCHES) return false;
    }
  };

  let skipped = [];
  if (statSync(root).isDirectory()) {
    skipped = walk(root, (fullPath, isDir) => (isDir || !included(fullPath) ? undefined : searchFile(fullPath)));
  } else {
    searchFile(root);
  }

  if (!matches.length) return skipped.length ? "no matches (files git ignores were not searched)" : "no matches";
  const suffix = matches.length >= MAX_GREP_MATCHES ? `\n[stopped at ${MAX_GREP_MATCHES} matches]` : "";
  return matches.join("\n") + suffix;
}

/**
 * Keeps the project's .agent folder (assets, saved conversations) out of git, the way
 * .pytest_cache does, by giving it a .gitignore that ignores everything in it.
 */
export function ignoreAgentFolder() {
  const ignoreFile = safeProjectPath(".agent/.gitignore");
  if (existsSync(ignoreFile)) return;
  mkdirSync(dirname(ignoreFile), { recursive: true });
  writeFileSync(ignoreFile, "*\n");
}

// Changes files through write(), recording them in `changes` (if given) so they can be undone.
function trackChange(changes, fullPath, write) {
  return changes ? changes.track(fullPath, write) : write();
}

function shellCommand(args) {
  if (!requireString(args, "cmd").trim()) throw new Error("cmd must not be empty");
  if (args.background) backgroundProcesses.checkRoom();
  return args.cmd;
}

// What edit_file would write: the file's full path and new text. Throws if the edit can't be made.
function plannedEdit(args) {
  const path = safeProjectPath(args.path);
  if (!requireString(args, "old_string")) throw new Error("old_string must not be empty");
  requireString(args, "new_string");
  if (!existsSync(path)) throw new Error(`${args.path} does not exist; create it with write_file`);
  checkWritable(path);

  const text = readFileSync(path, "utf8");
  const eol = lineEnding(text);
  const oldString = text.includes(args.old_string) ? args.old_string : withLineEndings(args.old_string, eol);
  const newString = withLineEndings(args.new_string, eol);

  const count = text.split(oldString).length - 1;
  if (count === 0) throw new Error("old_string not found");
  if (count > 1) throw new Error(`old_string appears ${count} times; add more context to make it unique`);

  // A replacer function avoids special "$" patterns in new_string.
  return { path, text: text.replace(oldString, () => newString) };
}

// The full path and content of a write_file or append_file call. Throws if it can't be made.
function plannedWrite(args) {
  const content = requireString(args, "content");
  const path = safeProjectPath(args.path);
  checkWritable(path);
  return { path, content };
}

function plannedAsset(args) {
  const content = requireString(args, "content");
  return { path: safeAssetPath(args.path), content };
}

/**
 * Whether `fullPath` is a folder, and the files that deleting or moving it changes, all of which
 * are kept in memory for /undo. Throws for what undo couldn't put back as it was: a link, a .git
 * folder (another repository), or more than MAX_TRACKED_FILES files or MAX_TRACKED_MB.
 */
function filesToTrack(fullPath, shown, verb) {
  const folder = lstatSync(fullPath).isDirectory();
  const files = [];
  let bytes = 0;
  const visit = (path) => {
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name.toLowerCase() === ".git") throw new Error(`${shown} contains a .git folder, which can't be changed`);
        visit(join(path, name));
      }
      return;
    }
    if (stats.isSymbolicLink()) throw new Error(`${shownPath(path)} is a link; use shell to ${verb} links`);
    if (!stats.isFile()) throw new Error(`${shownPath(path)} isn't a regular file; use shell to ${verb} it`);

    files.push(path);
    bytes += stats.size;
    if (files.length > MAX_TRACKED_FILES || bytes > MAX_TRACKED_MB * 1024 * 1024) {
      const size = folder ? `has more than ${MAX_TRACKED_FILES} files or ${MAX_TRACKED_MB} MB` : `is bigger than ${MAX_TRACKED_MB} MB`;
      throw new Error(`${shown} ${size}, too much to keep for undo; use shell to ${verb} it`);
    }
  };
  visit(fullPath);
  return { folder, files };
}

// Whether two existing paths are the same file, as names that differ only in case are on
// Windows and macOS.
function sameFile(a, b) {
  const [x, y] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
  return x.dev === y.dev && x.ino === y.ino;
}

// What delete_file would delete: the file or folder, whether it is a folder, and the files that
// go with it. Throws if it can't be deleted.
function plannedDelete(args) {
  const path = safeProjectPath(requireString(args, "path"));
  if (path === process.cwd()) throw new Error("The project folder itself can't be deleted");
  if (!existsSync(path)) throw new Error(`${args.path} does not exist`);
  checkWritable(path);
  return { path, ...filesToTrack(path, args.path, "delete") };
}

// What move_file would move, and the files it changes: those it moves, at both their old and
// new paths. Throws if the move can't be made.
function plannedMove(args) {
  const from = safeProjectPath(requireString(args, "from"));
  const to = safeProjectPath(requireString(args, "to"));
  if (from === process.cwd()) throw new Error("The project folder itself can't be moved");
  if (!existsSync(from)) throw new Error(`${args.from} does not exist`);
  checkWritable(from);
  if (existsSync(to)) {
    if (sameFile(from, to)) throw new Error(`${args.from} and ${args.to} are the same file; to change only the case of a name, use shell`);
    const into = statSync(to).isDirectory() ? `; to move it into that folder, include the name: ${args.to.replace(/[\\/]+$/, "")}/${basename(from)}` : "";
    throw new Error(`${args.to} already exists${into}`);
  }

  const { folder, files } = filesToTrack(from, args.from, "move");
  if (folder && !relative(from, to).startsWith("..")) throw new Error(`${args.from} can't be moved into itself`);
  checkWritable(to, { folder });
  return { from, to, files: [...files, ...files.map((file) => join(to, relative(from, file)))] };
}

// Removes `dir` and the folders above it while they are empty, up to the project folder.
function removeEmptyFolders(dir) {
  const root = process.cwd();
  while (dir !== root && !relative(root, dir).startsWith("..")) {
    try {
      rmdirSync(dir);
    } catch {
      return; // not empty
    }
    dir = dirname(dir);
  }
}

function moveSync(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    // Another drive or mount, like node_modules in the Docker sandbox: copy, then delete.
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true });
  }
}

const CHECKS = {
  shell: shellCommand,
  edit_file: plannedEdit,
  write_file: plannedWrite,
  append_file: plannedWrite,
  write_asset: plannedAsset,
  delete_file: plannedDelete,
  move_file: plannedMove,
  fetch_url: (args) => webUrl(args.url),
};

// Throws if a tool call that needs confirmation would fail anyway, like an edit whose
// old_string isn't in the file, so the user isn't asked to approve it. runTool checks again,
// since files can change while the user decides.
export function checkToolCall(name, args) {
  CHECKS[name]?.(args);
}

// Runs a tool and resolves to its text result, or for view_image to { content, parts }: the
// text result, and the message parts that show the image. Aborting `signal` stops a running
// shell command. File changes are recorded in `changes` (a FileChanges), if given, so they can
// be undone.
export async function runTool(name, args, { signal, changes } = {}) {
  if (name === "shell") {
    const cmd = shellCommand(args);
    if (args.background) return startInBackground(cmd, signal);
    return runShell(cmd, { signal, timeoutMs: shellTimeout(args.timeout) * 1000 });
  }

  if (name === "process_output") {
    const proc = backgroundProcesses.get(args.id);
    const wait = Math.min(Math.max(0, Number(args.wait) || 0), MAX_OUTPUT_WAIT);
    await backgroundProcesses.waitForOutput(proc, wait, signal);
    return processReport(proc);
  }

  if (name === "stop_process") {
    const proc = backgroundProcesses.get(args.id);
    await proc.stop();
    return processReport(proc);
  }

  if (name === "git") {
    return runGit(args);
  }

  if (name === "read_file") {
    return readFile(args);
  }

  // The model can't take an image in a tool result: it comes in a message after the results.
  if (name === "view_image") {
    const part = imagePart(safeProjectPath(requireString(args, "path")), args.path);
    return { content: `${args.path} follows as an image.`, parts: [{ type: "text", text: `${args.path}:` }, part] };
  }

  if (name === "fetch_url") {
    return fetchUrl(args.url, { start: args.start, maxChars: MAX_TOOL_OUTPUT, signal });
  }

  // Models often send "" or null for "the project root".
  if (name === "list_dir") {
    return listDir(args.path || ".", args.recursive);
  }

  if (name === "find_files") {
    return findFiles(requireString(args, "pattern"), args.path || ".");
  }

  if (name === "grep") {
    return grep({
      pattern: requireString(args, "pattern"),
      path: args.path || ".",
      glob: args.glob ? requireString(args, "glob") : null,
      ignoreCase: args.ignore_case,
    });
  }

  if (name === "edit_file") {
    const { path, text } = plannedEdit(args);
    trackChange(changes, path, () => writeFileSync(path, text));
    return "ok";
  }

  if (name === "append_file") {
    const { path, content } = plannedWrite(args);
    trackChange(changes, path, () => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, withLineEndings(content, existingLineEnding(path)));
    });
    return "ok";
  }

  if (name === "write_file") {
    const { path, content } = plannedWrite(args);
    trackChange(changes, path, () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, withLineEndings(content, existingLineEnding(path)));
    });
    return "ok";
  }

  if (name === "delete_file") {
    const { path, folder, files } = plannedDelete(args);
    trackChange(changes, files, () => {
      rmSync(path, { recursive: true });
      removeEmptyFolders(dirname(path));
    });
    return folder ? `deleted ${args.path} (a folder with ${files.length === 1 ? "1 file" : `${files.length} files`})` : `deleted ${args.path}`;
  }

  if (name === "move_file") {
    const { from, to, files } = plannedMove(args);
    trackChange(changes, files, () => {
      mkdirSync(dirname(to), { recursive: true });
      moveSync(from, to);
      removeEmptyFolders(dirname(from));
    });
    return `moved ${args.from} to ${args.to}`;
  }

  if (name === "write_asset") {
    const { path, content } = plannedAsset(args);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);

    ignoreAgentFolder();
    return `saved to ${ASSET_DIR}/${args.path}`;
  }

  return `Unknown tool: ${name}`;
}

