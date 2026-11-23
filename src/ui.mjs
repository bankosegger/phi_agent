import { box, displayWidth, glyphs as defaultGlyphs, padEnd, rule, theme, truncateMiddle } from "./theme.mjs";

// What the CLI prints, as text: the banner, tool calls and what they show, the question before
// one runs, the line after each task, and the help.

export function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// "a, b, c and 4 more"
export function nameList(names, max = 5) {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

// "950", "12.5k", "1M"
export function formatTokens(count) {
  if (count < 1000) return String(count);
  if (count < 999_950) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// "$0.12", or "~$0.12" for an estimate.
export function formatCost(dollars, estimated = false) {
  return `${estimated ? "~" : ""}$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`;
}

// "0.4s", "45s", "12m 5s", "2h 3m"
export function formatDuration(ms) {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// The widest a line may be: one column short of the terminal, as some terminals add a blank
// line after one that fills a row.
export function lineWidth(columns) {
  return Math.max(20, (columns || 80) - 1);
}

// Tool names as the user sees them, as verbs.
export const TOOL_LABELS = {
  read_file: "Read",
  list_dir: "List",
  find_files: "Find",
  grep: "Search",
  git: "Git",
  view_image: "View",
  fetch_url: "Fetch",
  web_search: "Web",
  process_output: "Output",
  stop_process: "Stop",
  shell: "Run",
  edit_file: "Edit",
  write_file: "Write",
  append_file: "Append",
  write_asset: "Save",
  delete_file: "Delete",
  move_file: "Move",
  todo_write: "To-dos",
  subagent: "Helper",
};

// Tools that only look around. Their calls are shown quietly; calls that change things stand out.
const LOOKING_TOOLS = new Set(["read_file", "list_dir", "find_files", "grep", "git", "view_image", "fetch_url", "web_search", "process_output"]);

const INDENT = "  ";

/**
 * A tool's name as the user sees it: a verb for the agent's own, like "Edit", and the server and
 * the tool for an MCP server's, like "github/create_issue" for mcp__github__create_issue.
 */
export function toolLabel(name) {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const mcp = String(name).match(/^mcp__(.+?)__(.+)$/);
  return mcp ? `${mcp[1]}/${mcp[2]}` : name;
}

/** A tool call's line, like "● Edit src/app.js". */
export function toolCallLine(name, summary, g = defaultGlyphs) {
  const label = toolLabel(name);
  const text = summary ? ` ${summary}` : "";
  if (LOOKING_TOOLS.has(name)) return theme.muted(`${g.tool} ${label}${text}`);
  return `${theme.accent(g.tool)} ${theme.strong(label)}${text}`;
}

/**
 * The lines shown under a tool call (see preview.mjs): a numbered diff, a command's output, an
 * error or a note, indented under the call.
 */
export function detailLines(lines, g = defaultGlyphs) {
  const width = Math.max(0, ...lines.map((line) => String(line.number ?? "").length));
  const number = (line) => (width ? `${theme.muted(String(line.number ?? "").padStart(width))} ` : "");
  const textColumn = width ? " ".repeat(width + 1) : "";
  return lines.map((line) => {
    if (line.kind === "add") return `${INDENT}${number(line)}${theme.success(`+ ${line.text}`)}`;
    if (line.kind === "remove") return `${INDENT}${number(line)}${theme.danger(`- ${line.text}`)}`;
    if (line.kind === "same") return `${INDENT}${number(line)}${theme.muted(`  ${line.text}`)}`;
    if (line.kind === "gap") return `${INDENT}${theme.muted(g.gap.padStart(Math.max(1, width)))}`;
    if (line.kind === "output") return `${INDENT}${theme.muted(`${g.gutter} ${line.text}`)}`;
    if (line.kind === "error") return `${INDENT}${theme.danger(`${g.fail} ${line.text}`)}`;
    if (line.kind === "ok") return `${INDENT}${theme.success(g.ok)} ${theme.muted(line.text)}`;
    // A step of a to-do list: done, being done, or to do.
    if (line.kind === "todo" && line.status === "completed") return `${INDENT}${theme.success(g.ok)} ${theme.muted(line.text)}`;
    if (line.kind === "todo" && line.status === "in_progress") return `${INDENT}${theme.accent(g.arrow)} ${theme.strong(line.text)}`;
    if (line.kind === "todo") return `${INDENT}${theme.muted(g.skip)} ${line.text}`;
    return `${INDENT}${textColumn}${theme.muted(line.text)}`;
  });
}

// A line under a tool call about how it went, like "○ Skipped".
export function outcomeLine(text, { style = theme.muted, symbol } = {}) {
  return `${INDENT}${style(`${symbol ? `${symbol} ` : ""}${text}`)}`;
}

const QUESTIONS = {
  shell: (args) => (args?.background ? "Start this in the background?" : "Run this command?"),
  edit_file: () => "Make this edit?",
  write_file: () => "Write this file?",
  append_file: () => "Append to this file?",
  write_asset: () => "Save this file?",
  delete_file: () => "Delete this?",
  move_file: () => "Move this?",
  fetch_url: () => "Fetch this page?",
  web_search: () => "Search the web?",
  stop_process: () => "Stop this process?",
  // Files that may hold secrets.
  read_file: () => "Let the model read it?",
  grep: () => "Let the model search it?",
};

// What answering "a" allows, from a permission rule (see permissions.mjs): commands that start
// with some words, pages from a site, or a tool's calls.
const TOOL_NOUNS = { edit_file: "edits", write_file: "file writes", append_file: "appends", write_asset: "saved files", delete_file: "deletes", move_file: "moves" };

export function ruleScope(rule) {
  if (rule.startsWith("shell: ")) return `"${rule.slice(7)}"`;
  if (rule.startsWith("fetch_url: ")) return rule.slice(11);
  return TOOL_NOUNS[rule] ?? `${/^mcp__/.test(rule) ? toolLabel(rule) : rule} calls`;
}

/** A question for the user, like "  ? Delete this? y/N › ", with the answer to go after it. */
export function questionLine(question, choices = "y/N") {
  return `${INDENT}${theme.warning("?")} ${theme.strong(question)} ${theme.muted(choices)} ${theme.accent("›")} `;
}

/**
 * The question before a tool call runs, offering "a" (always) when there is a rule to save.
 * In a narrow terminal, the choices are only named, so that the answer fits on the line.
 */
export function confirmPrompt(name, args, rule, g = defaultGlyphs, columns = 80) {
  const question = QUESTIONS[name]?.(args) ?? `Run ${toolLabel(name)}?`;
  const ask = (choices) => questionLine(question, choices);
  if (!rule) return ask("y/N");
  const full = ask(`y/N · a = always allow ${ruleScope(rule)}`);
  // Room for the answer after it, too.
  return displayWidth(full) + 4 <= lineWidth(columns) ? full : ask("y/N/a");
}

/**
 * The line after a task: how long it took, its tokens (and how many of those came from the
 * prompt cache) and cost, and how full the model's context is, in a rule across the terminal. A
 * narrow terminal gets a shorter version. Costs worked out from list prices (`usage.estimated`,
 * and `sessionEstimated` for the session's) are marked as estimates.
 */
export function taskFooter({ elapsed, usage, sessionCost = 0, sessionEstimated = false, context = {} }, columns, g = defaultGlyphs) {
  const parts = (short) => {
    const list = [];
    if (elapsed != null) list.push(formatDuration(elapsed));
    if (usage?.requests) {
      const tokens = [formatTokens(usage.input), formatTokens(usage.output)];
      const cached = usage.cached ? ` (${formatTokens(usage.cached)} cached)` : "";
      list.push(short ? `${tokens.join("/")} tokens` : `${tokens[0]} in${cached} · ${tokens[1]} out`);
      if (usage.cost != null) {
        const cost = formatCost(usage.cost, usage.estimated);
        list.push(!short && sessionCost > usage.cost ? `${cost} (session ${formatCost(sessionCost, sessionEstimated)})` : cost);
      }
    }
    if (context.used != null) {
      const percent = context.limit ? `${Math.round((100 * context.used) / context.limit)}%` : null;
      if (short) list.push(`${percent ?? formatTokens(context.used)} context`);
      else list.push(percent ? `${percent} of ${formatTokens(context.limit)} context` : `${formatTokens(context.used)} tokens of context`);
    }
    return list;
  };
  const width = Math.min(lineWidth(columns), 100);
  const fits = (list) => displayWidth(list.join(" · ")) + 4 <= width;
  let label = parts(false);
  if (!fits(label)) label = parts(true);
  while (label.length > 1 && !fits(label)) label.pop();
  return rule(theme.muted(label.join(" · ")), width, { g });
}

/**
 * The banner the CLI starts with: the model, the project folder, the instructions it follows,
 * the settings files it uses, and any mode that changes what the agent may do. In a box if the
 * terminal is wide enough.
 */
export function banner({ version, model, project, following = [], settings = [], sandbox = false, plan = false, yes = false }, columns, g = defaultGlyphs) {
  const title = `${theme.accent(g.tool)} ${theme.strong("Tiny Agent")}${version ? ` ${theme.muted(`v${version}`)}` : ""}`;
  const rows = [
    ["model", model],
    ["project", project],
    following.length && ["follows", following.join(", ")],
    settings.length && ["settings", settings.join(", ")],
    sandbox && ["sandbox", "Docker, with the project at /workspace"],
    plan && ["mode", theme.plan("plan: looks around and changes nothing")],
    yes && ["approve", theme.warning("everything, without asking (--yes)")],
  ].filter(Boolean);
  const labelWidth = Math.max(...rows.map(([label]) => label.length));

  const width = lineWidth(columns);
  const boxed = width >= 44;
  // What fits inside: the box's border and padding take 4 columns.
  const inner = width - (boxed ? 4 : 0);
  const valueWidth = inner - labelWidth - 2;
  const hint = ["/help for commands · Tab completes · ↑ for history", "/help for commands"].find((text) => displayWidth(text) <= inner) ?? "/help";
  const lines = [
    title,
    "",
    ...rows.map(([label, value]) => `${theme.muted(label.padEnd(labelWidth))}  ${displayWidth(value) > valueWidth ? truncateMiddle(value, valueWidth) : value}`),
    "",
    theme.muted(hint),
  ];
  return boxed ? box(lines, { g }) : lines;
}

const COMMANDS = [
  ["/help", "[name]", "Show this help, or one of your commands in full"],
  ["/clear", "", "Start a new conversation"],
  ["/resume", "[n]", "List the saved conversations, or continue conversation n. /resume <words> finds them by their tasks; /resume delete <n> deletes one"],
  ["/compact", "", "Summarize the conversation so far, to free up the model's context"],
  ["/undo", "", "Revert the file changes of the last task (again for the task before)"],
  ["/plan", "", "Plan mode on or off: the agent only looks around and replies with a plan"],
  ["/model", "[name]", "Show the model, or switch to another: an OpenRouter model, or a Claude model like claude-opus-5-5"],
  ["/processes", "", "List the commands the agent left running in the background"],
  ["/stop", "<n|all>", "Stop background process n, or all of them"],
  ["/permissions", "", "List what runs without asking (/permissions remove <n> takes one back)"],
  ["/mcp", "", "List the MCP servers and their tools"],
  ["/exit", "", "Quit (also /quit, or Ctrl+D)"],
];

const KEYS = [
  ["Ctrl+C", "Cancel the task the agent is working on; at the prompt, clear what you typed, or quit"],
  ["Tab", "Complete commands, model names and file paths"],
  ["Up, Down", "Bring back what you entered before in this project"],
  ["Ctrl+R", "Search what you entered before: type part of it, Ctrl+R again for older, Enter to run it, Tab to edit it, Esc to go back"],
];

const TIPS = [
  "Messages you enter while the agent works run after the task. Pasted lines are sent together as one message. To type a message of several lines, end each line but the last with \\.",
  "Add your own commands: a prompt in .phi-agent/commands/<name>.md, in the project or in your home folder, runs with /<name>. $ARGUMENTS in it stands for what you write after the command.",
  "To show the model an image, put its path in your message (drag the file into the terminal), or @ and a project path, like @docs/mockup.png. @ a text file, like @src/app.js, and the model gets its content too (up to 100 KB; files that may hold secrets are left out).",
  'At a confirmation, answer y (yes), n (no), or a (always): from then on, in this project, commands that start the same way run without asking, and so do pages from the same site, or the same file tool. Commands that chain others, and ones like rm, always ask.',
];

// Words of `text` in lines of at most `width` columns.
function wrap(text, width) {
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current && displayWidth(`${current} ${word}`) > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Where the user's own commands come from, by scope (see commands.mjs), as /help heads them.
const COMMAND_SOURCES = [
  ["project", "Project commands", ".phi-agent/commands"],
  ["user", "Your commands", "~/.phi-agent/commands"],
];

/**
 * The /help text, as lines, with the user's own commands (see commands.mjs), if any, under the
 * folder they come from: each with what to write after it and the model it runs with, if its
 * file says. Then the command files that were skipped, each with why.
 */
export function helpLines(columns, g = defaultGlyphs, custom = [], skipped = []) {
  const width = Math.min(lineWidth(columns), 100);
  const usage = ({ name, argumentHint }) => `/${name}${argumentHint ? ` ${argumentHint}` : ""}`;
  const nameWidth = Math.max(
    ...COMMANDS.map(([name, args]) => displayWidth(`${name} ${args}`.trim())),
    ...custom.map((command) => Math.min(24, displayWidth(usage(command)))),
    ...KEYS.map(([key]) => key.length),
  );
  const entry = (name, description) => {
    // The description wraps in its own column.
    const [first = "", ...rest] = wrap(description, Math.max(20, width - nameWidth - 4));
    return [`${INDENT}${padEnd(name, nameWidth)}  ${first}`, ...rest.map((line) => `${INDENT}${" ".repeat(nameWidth)}  ${line}`)];
  };
  const own = COMMAND_SOURCES.flatMap(([scope, title, folder]) => {
    const commands = custom.filter((command) => (command.scope ?? "user") === scope).sort((a, b) => (a.name < b.name ? -1 : 1));
    if (!commands.length) return [];
    return [
      `${theme.strong(title)}  ${theme.muted(folder)}`,
      ...commands.flatMap(({ name, argumentHint, description, model }) => {
        const shown = `${theme.accent(`/${name}`)}${argumentHint ? ` ${theme.muted(argumentHint)}` : ""}`;
        return entry(shown, model ? `${description} (${model})`.trim() : description);
      }),
      "",
    ];
  });
  const notUsed = skipped.length
    ? [theme.muted("Not used:"), ...skipped.map(({ file, reason }) => `${INDENT}${theme.muted(`${file} — ${reason}`)}`), ""]
    : [];
  return [
    theme.strong("Commands"),
    ...COMMANDS.flatMap(([name, args, description]) => {
      const shown = `${theme.accent(name)}${args ? ` ${theme.muted(args)}` : ""}`;
      return entry(shown, description);
    }),
    "",
    ...own,
    ...notUsed,
    theme.strong("Keys"),
    ...KEYS.flatMap(([key, description]) => entry(theme.accent(key), description)),
    "",
    theme.strong("Tips"),
    ...TIPS.flatMap((tip) => {
      const [first, ...rest] = wrap(tip, width - 4);
      return [`${INDENT}${theme.muted(g.bullet)} ${first}`, ...rest.map((line) => `${INDENT}  ${line}`)];
    }),
  ];
}

/**
 * The /help <name> text, as lines: one of the user's own commands (see commands.mjs) in full,
 * with what to write after it and the model it runs with, if its file says.
 */
export function commandLines({ name, description, prompt, model = null, argumentHint = null }, file) {
  const from = `from ${file}${model ? ` · runs with ${model}` : ""}`;
  const shown = `${theme.accent(`/${name}`)}${argumentHint ? ` ${theme.muted(argumentHint)}` : ""}`;
  return [shown + (description ? `  ${theme.muted(description)}` : ""), theme.muted(from), "", ...prompt.split("\n")];
}

/** A line of markdown as plain text, for a preview: "## **Fixed** `add`" is "Fixed add". */
export function markdownAsText(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/\[([^\][]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(?=\S)(.+?)(?<=\S)\1/g, "$2");
}

/**
 * Items numbered from 1, or with the given `numbers`, the numbers in color: "  1  first". An item
 * can be an array of lines, the lines after its first going under its text.
 */
export function numberedLines(items, numbers = items.map((_, i) => i + 1)) {
  const width = Math.max(0, ...numbers.map((number) => String(number).length));
  return items.flatMap((item, i) => {
    const [first, ...rest] = Array.isArray(item) ? item : [item];
    return [`${INDENT}${theme.accent(String(numbers[i]).padStart(width))}  ${first}`, ...rest.map((line) => `${INDENT}${" ".repeat(width)}  ${line}`)];
  });
}

/**
 * Part of `text`, on one line and at most `max` characters, around the first of `words` it has
 * (in any case), with "…" where it was cut: for showing where a search found something.
 */
export function excerpt(text, words, max = 60) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const lower = line.toLowerCase();
  const at = Math.min(...words.map((word) => lower.indexOf(String(word).toLowerCase())).filter((index) => index >= 0), Infinity);
  // The word a third of the way in, so there is some of what comes before it, but no further
  // than the end of the text allows: after a "…", max - 1 characters of it fit.
  let start = at === Infinity ? 0 : Math.max(0, Math.min(at - Math.floor(max / 3), line.length - max + 1));
  // Cuts fall between words where one is near, not before the word found.
  if (start > 0 && line[start - 1] !== " ") {
    const next = line.indexOf(" ", start) + 1;
    if (next > 0 && next <= Math.min(at, start + 10)) start = next;
  }
  let end = start + max - (start > 0 ? 1 : 0);
  const cut = end < line.length;
  if (cut) {
    end--; // room for the "…" at the end
    const space = line.lastIndexOf(" ", end);
    if (space > start && end - space <= 10) end = space;
  }
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${cut ? "…" : ""}`;
}
