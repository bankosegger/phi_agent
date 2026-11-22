import chalk from "chalk";

// Colors for code in the model's replies, a line at a time: keywords, strings, numbers and
// comments, for the languages models write most. A comment or string that spans lines is only
// colored on its first line, which is close enough for reading.

export const SYNTAX_STYLES = {
  keyword: (text) => chalk.magenta(text),
  string: (text) => chalk.green(text),
  number: (text) => chalk.yellow(text),
  comment: (text) => chalk.dim(text),
  key: (text) => chalk.cyan(text),
  variable: (text) => chalk.cyan(text),
  added: (text) => chalk.green(text),
  removed: (text) => chalk.red(text),
  meta: (text) => chalk.cyan(text),
  prompt: (text) => chalk.dim(text),
};

const words = (list) => new Set(list.split(" "));

const C_COMMENTS = { comment: "//", blockComments: true };

const LANGUAGES = {
  js: {
    ...C_COMMENTS,
    backticks: true,
    keywords: words(
      "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield",
    ),
  },
  python: {
    comment: "#",
    keywords: words(
      "and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return self True try while with yield",
    ),
  },
  shell: {
    comment: "#",
    shellComments: true,
    backticks: true,
    variables: /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@#?$!*-])/y,
    keywords: words("case declare do done elif else esac exit export fi for function if in local readonly return then until while"),
  },
  powershell: {
    comment: "#",
    shellComments: true,
    caseless: true,
    variables: /\$[\w:]+/y,
    keywords: words("begin catch do else elseif end exit finally for foreach function if in param process return switch throw try until while"),
  },
  go: {
    ...C_COMMENTS,
    backticks: true,
    keywords: words(
      "break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var",
    ),
  },
  rust: {
    ...C_COMMENTS,
    charLiterals: true,
    keywords: words(
      "as async await break const continue crate dyn else enum Err extern false fn for if impl in let loop match mod move mut None Ok pub ref return Self self Some static struct super trait true type unsafe use where while",
    ),
  },
  c: {
    ...C_COMMENTS,
    keywords: words(
      "abstract auto bool boolean break byte case catch char class const continue default delete do double else enum extends extern false final finally float for goto if implements import include int interface long namespace new null nullptr override package private protected public record register return short signed sizeof static string struct super switch template this throw throws true try typedef typename union unsigned using var virtual void volatile while",
    ),
  },
  sql: {
    comment: "--",
    caseless: true,
    keywords: words(
      "add all alter and as asc between by case create default delete desc distinct drop else end exists foreign from group having in index inner insert into is join key left like limit not null offset on or order outer primary references right select set table then union update values when where with",
    ),
  },
  yaml: { comment: "#", keys: /^(\s*(?:-\s+)?)([^\s#:][^#:]*?)(:)(?=\s|$)/, keywords: words("true false null yes no on off") },
  toml: { comment: "#", keys: /^(\s*)([\w."-]+)(\s*=)/, sections: true, keywords: words("true false") },
  json: { json: true, keywords: words("true false null") },
};

const ALIASES = {
  javascript: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  typescript: "js",
  tsx: "js",
  py: "python",
  python3: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  pwsh: "powershell",
  golang: "go",
  rs: "rust",
  h: "c",
  cpp: "c",
  "c++": "c",
  cc: "c",
  cs: "c",
  csharp: "c",
  java: "c",
  kotlin: "c",
  kt: "c",
  swift: "c",
  php: "c",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
};

// Languages whose lines are commands after a prompt, with output in between.
const SESSIONS = new Set(["console", "terminal", "shell-session", "shellsession"]);
const DIFFS = new Set(["diff", "patch"]);

const patterns = new Map();

// One regex that finds the next token of a language, with a named group for each kind.
function tokenPattern(spec) {
  if (patterns.has(spec)) return patterns.get(spec);
  const parts = [];
  if (spec.comment === "//") parts.push("(?<comment>\\/\\/.*$)");
  if (spec.blockComments) parts.push("(?<block>\\/\\*.*?(?:\\*\\/|$))");
  if (spec.comment === "#") parts.push(spec.shellComments ? "(?<comment>(?<![^\\s])#.*$)" : "(?<comment>#.*$)");
  if (spec.comment === "--") parts.push("(?<comment>--.*$)");
  const strings = ['"(?:[^"\\\\]|\\\\.)*"?'];
  if (spec.charLiterals) strings.push("'(?:[^'\\\\]|\\\\.)'");
  else strings.push("'(?:[^'\\\\]|\\\\.)*'?");
  if (spec.backticks) strings.push("`(?:[^`\\\\]|\\\\.)*`?");
  parts.push(`(?<string>${strings.join("|")})`);
  if (spec.variables) parts.push(`(?<variable>${spec.variables.source})`);
  parts.push("(?<number>\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)");
  parts.push("(?<word>[A-Za-z_][\\w]*)");
  const pattern = new RegExp(parts.join("|"), "g");
  patterns.set(spec, pattern);
  return pattern;
}

function highlightTokens(text, spec, styles) {
  const pattern = tokenPattern(spec);
  pattern.lastIndex = 0;
  let result = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const { comment, block, string, variable, number, word } = match.groups;
    let styled = match[0];
    if (comment != null || block != null) styled = styles.comment(match[0]);
    else if (string != null) {
      // In JSON, a string followed by a colon is a key.
      const isKey = spec.json && /^\s*:/.test(text.slice(match.index + match[0].length));
      styled = isKey ? styles.key(string) : styles.string(string);
    } else if (variable != null) styled = styles.variable(variable);
    else if (number != null) styled = styles.number(number);
    else if (word != null && spec.keywords?.has(spec.caseless ? word.toLowerCase() : word)) styled = styles.keyword(word);
    result += text.slice(last, match.index) + styled;
    last = match.index + match[0].length;
  }
  return result + text.slice(last);
}

function highlightDiff(line, styles) {
  if (/^(\+\+\+|---)( |$)/.test(line)) return styles.meta(line);
  if (line.startsWith("+")) return styles.added(line);
  if (line.startsWith("-")) return styles.removed(line);
  if (line.startsWith("@@")) return styles.meta(line);
  return line;
}

/** Whether there are colors for `language`, a code block's language name like "js" or "bash". */
export function canHighlight(language) {
  const name = String(language ?? "").toLowerCase();
  return Boolean(LANGUAGES[ALIASES[name] ?? name]) || SESSIONS.has(name) || DIFFS.has(name);
}

/**
 * `line` of code in `language`, with colors. Lines in a language without colors (see
 * canHighlight) come back as they are.
 */
export function highlight(line, language, styles = SYNTAX_STYLES) {
  const name = String(language ?? "").toLowerCase();
  if (DIFFS.has(name)) return highlightDiff(line, styles);
  if (SESSIONS.has(name)) {
    const command = line.match(/^(\s*(?:\$|PS[^>]*>|>)\s)(.*)$/);
    return command ? styles.prompt(command[1]) + highlightTokens(command[2], LANGUAGES.shell, styles) : line;
  }
  const spec = LANGUAGES[ALIASES[name] ?? name];
  if (!spec) return line;

  // A comment line inside a /* */ block, like " * @param x" in a doc comment.
  if (spec.blockComments && /^\s*\*(\s|\/|$)/.test(line)) return styles.comment(line);
  if (spec.sections && /^\s*\[.*\]\s*$/.test(line)) return styles.key(line);
  const key = spec.keys && line.match(spec.keys);
  if (key) {
    const [whole, indent, keyName, separator] = key;
    return indent + styles.key(keyName) + separator + highlightTokens(line.slice(whole.length), spec, styles);
  }
  return highlightTokens(line, spec, styles);
}
