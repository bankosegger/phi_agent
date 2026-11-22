import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ignoreAgentFolder, needsConfirmation } from "./tools.mjs";

// Tool calls the user allowed for good in a project, saved in .agent/permissions.json as rules
// like "shell: npm test" (shell commands that start with it), "fetch_url: docs.python.org"
// (pages on that host) or "edit_file" (every call of that tool).

export const PERMISSIONS_FILE = ".agent/permissions.json";

// What can make one command run others, or write files: a rule for "npm test" mustn't allow
// "npm test && rm -rf ~" or "npm test > package.json". Quotes don't help: they are kept in.
const CHAINING = /[;&|`<>\n\r]|\$\(/;
// Commands whose damage can't be undone, which are never allowed for good.
const DANGEROUS = new Set(["rm", "rmdir", "del", "erase", "rd", "sudo", "su", "doas", "dd", "mkfs", "format", "shutdown", "reboot", "chmod", "chown", "kill", "killall", "pkill", "taskkill"]);
// Commands that run whatever script or code follows: a rule names the script too.
const INTERPRETERS = new Set(["node", "python", "python3", "py", "ruby", "perl", "php", "bash", "sh", "zsh", "pwsh", "powershell", "deno", "bun", "tsx"]);
// Subcommands that run a script named next, like "npm run build".
const RUNNERS = new Set(["run", "exec", "x", "run-script"]);

// The command's words, with runs of spaces as one.
function words(cmd) {
  return String(cmd ?? "").trim().split(/\s+/).filter(Boolean);
}

// The program a word names, without a folder or a Windows extension: "./node_modules/.bin/vitest" is vitest.
function program(word) {
  return basename(word.replaceAll("\\", "/")).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * The start of a shell command that a rule allowing it would name: "npm test" for "npm test --
 * --run", "npm run build" for "npm run build", "node scripts/x.js" for "node scripts/x.js --fast",
 * "ls" for "ls -la". Null for a command no rule may allow: one that chains others or redirects
 * output, or one that can do damage that can't be undone, like rm.
 */
export function commandPrefix(cmd) {
  if (CHAINING.test(cmd ?? "")) return null;
  // Settings like CI=1 before the program stay in the prefix, but aren't the program.
  const all = words(cmd);
  const settings = all.slice(0, Math.max(0, all.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word))));
  const [first, second, third] = all.slice(settings.length);
  const prefix = (...parts) => [...settings, ...parts].join(" ");

  if (!first || DANGEROUS.has(program(first))) return null;
  if (!second) return prefix(first);
  // "node -e ..." runs any code it is given: only that exact command.
  if (INTERPRETERS.has(program(first))) return second.startsWith("-") ? all.join(" ") : prefix(first, second);
  // An option or a file ("ls -la", "pytest tests/a.py") isn't part of what the command does.
  if (second.startsWith("-") || /[/\\.]/.test(second)) return prefix(first);
  if (RUNNERS.has(second) && third && !third.startsWith("-")) return prefix(first, second, third);
  return prefix(first, second);
}

/**
 * The rule that would allow this tool call for good, like "shell: npm test", or null if the
 * call can't be allowed for good, like a command that chains others.
 */
export function ruleFor(name, args) {
  if (name === "shell") {
    const prefix = commandPrefix(args?.cmd);
    return prefix && `shell: ${prefix}`;
  }
  if (name === "fetch_url") {
    const host = URL.parse(String(args?.url ?? "").trim())?.host;
    return host ? `fetch_url: ${host}` : null;
  }
  return needsConfirmation(name) ? name : null;
}

// Whether a rule allows a tool call.
function matches(rule, name, args) {
  const [tool, scope] = rule.split(/: (.*)/s);
  if (tool !== name) return false;
  if (name === "shell") {
    if (!scope || CHAINING.test(args?.cmd ?? "") || commandPrefix(args?.cmd) == null) return false;
    const command = words(args.cmd).join(" ");
    return command === scope || command.startsWith(`${scope} `);
  }
  if (name === "fetch_url") return Boolean(scope) && URL.parse(String(args?.url ?? "").trim())?.host === scope;
  return scope === undefined;
}

/** Whether one of the rules allows a tool call without asking. */
export function allows(rules, name, args) {
  return rules.some((rule) => matches(rule, name, args));
}

/** The rules saved for the project, or none if there is no file (or it can't be read). */
export function loadRules(file = PERMISSIONS_FILE) {
  try {
    const { allow } = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(allow) ? allow.filter((rule) => typeof rule === "string" && rule.trim()) : [];
  } catch {
    return [];
  }
}

/** Saves the project's rules, replacing the file in one step. */
export function saveRules(rules, file = PERMISSIONS_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  ignoreAgentFolder();
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ allow: rules }, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
