import { spawn } from "node:child_process";
import { commandEnv, killProcessTree } from "./processes.mjs";
import { displayWidth } from "./theme.mjs";

// The status line above the prompt: the model in use, the git branch (with a * when there are
// changes to tracked files that aren't committed), and the modes that change what the agent
// does. Or, with "statusLine": "<command>" in the user's own settings, the first line that
// command prints, given what the agent knows as JSON on its input.

const GIT_TIMEOUT_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000;
const MAX_OUTPUT = 64 * 1024;

// Runs a program, or with `shell` a command line, without the API keys in its environment (see
// commandEnv). Resolves to what it printed, or null if it fails or doesn't end in `timeoutMs`.
function run(command, args, { shell = false, input = null, cwd = process.cwd(), timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell, cwd, env: commandEnv(), stdio: [input == null ? "ignore" : "pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    const timer = setTimeout(() => {
      killProcessTree(child);
      resolve(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : null);
    });
    if (input != null) {
      child.stdin.on("error", () => {}); // a command that doesn't read its input
      child.stdin.end(input);
    }
  });
}

/**
 * The git branch of the folder, and whether its tracked files have changes that aren't
 * committed: { branch, dirty }, or null outside a repository (or if git takes too long). A
 * detached HEAD is named by its commit.
 */
export async function gitState(cwd = process.cwd()) {
  const output = await run("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=no"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (output == null) return null;
  let branch = null;
  let commit = null;
  let dirty = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.oid ")) commit = line.slice("# branch.oid ".length);
    else if (line && !line.startsWith("#")) dirty = true;
  }
  if (branch === "(detached)") branch = commit && commit !== "(initial)" ? commit.slice(0, 7) : "detached";
  return branch ? { branch, dirty } : null;
}

/** The built-in status line's parts, joined: "claude-opus-5-5 · main* · plan mode". */
export function statusText({ model, git = null, plan = false, sandbox = false, yes = false }) {
  return [model, git && `${git.branch}${git.dirty ? "*" : ""}`, plan && "plan mode", sandbox && "sandbox", yes && "approves everything"].filter(Boolean).join(" · ");
}

// Colors and styles (SGR, like ESC[32m) are kept in a command's line; any other escape or
// control character could move the cursor and break the prompt under it. An OSC sequence, like
// a link's, goes whole, so its address isn't left as text.
const ESCAPES = /\x1b\[[0-9;]*m|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f]/g;
const SGR = /^\x1b\[[0-9;]*m$/;

/**
 * `line` cut to `width` columns, with … at the end if it was cut. Color codes in it count for
 * nothing, are never cut in half, and are reset at the end.
 */
export function fitLine(line, width) {
  if (displayWidth(line) <= width) return line;
  let kept = "";
  let used = 0;
  let styled = false;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (SGR.test(part)) {
      kept += part;
      styled = true;
      continue;
    }
    for (const char of part) {
      const charWidth = displayWidth(char);
      if (used + charWidth > width - 1) return `${kept}…${styled ? "\x1b[0m" : ""}`;
      kept += char;
      used += charWidth;
    }
  }
  return kept;
}

/**
 * The first line `command` prints, run with the shell, given `info` as JSON on its input: null
 * if it fails, prints nothing, or doesn't end within two seconds. Its colors are kept, and other
 * control characters left out.
 */
export async function commandStatus(command, info, { cwd = process.cwd(), timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const output = await run(command, [], { shell: true, input: `${JSON.stringify(info)}\n`, cwd, timeoutMs });
  const line = output
    ?.split(/\r?\n/)
    .map((text) => text.replaceAll("\t", " ").replace(ESCAPES, (match) => (SGR.test(match) ? match : "")))
    .find((text) => displayWidth(text.trim()) > 0);
  return line ?? null;
}
