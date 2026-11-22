import chalk from "chalk";
import { stripVTControlCharacters } from "node:util";

// How the CLI looks: its symbols, colors, and the boxes and rules it draws.

/**
 * Whether the terminal can draw symbols like ✓, ❯ and the braille spinner. The old Windows
 * console can't with its fonts; Windows Terminal, VS Code and terminals elsewhere can.
 */
export function supportsUnicode(env = process.env, platform = process.platform) {
  if (platform !== "win32") return env.TERM !== "linux"; // the Linux console's font is small too
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.TERM || env.ConEmuANSI === "ON");
}

export const UNICODE_GLYPHS = {
  prompt: "❯",
  continued: "…",
  tool: "●",
  ok: "✓",
  fail: "✗",
  skip: "○",
  warn: "!",
  arrow: "→",
  gutter: "│",
  bullet: "•",
  subBullet: "◦",
  rule: "─",
  gap: "⋮",
  corners: ["╭", "╮", "╰", "╯"],
  side: "│",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

// For the old Windows console: only symbols its fonts have.
export const LEGACY_GLYPHS = {
  ...UNICODE_GLYPHS,
  prompt: ">",
  continued: ".",
  ok: "√",
  fail: "×",
  gap: ":",
  corners: ["┌", "┐", "└", "┘"],
  spinner: ["-", "\\", "|", "/"],
};

export const glyphs = supportsUnicode() ? UNICODE_GLYPHS : LEGACY_GLYPHS;

// Whether output has colors: not with NO_COLOR, say, or when it isn't a terminal.
export function hasColors() {
  return chalk.level > 0;
}

// Colors by what they mean. Named colors follow the terminal's theme, light or dark.
export const theme = {
  accent: (text) => chalk.cyan(text),
  muted: (text) => chalk.dim(text),
  strong: (text) => chalk.bold(text),
  success: (text) => chalk.green(text),
  warning: (text) => chalk.yellow(text),
  danger: (text) => chalk.red(text),
  plan: (text) => chalk.magenta(text),
};

/**
 * Columns a string takes in a terminal: wide characters (CJK, most emoji) take two, combining
 * marks and joiners none, and color codes none.
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) {
    const code = char.codePointAt(0);
    if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) continue;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

// `text` (without color codes) cut to `width` columns, with … in place of the end.
export function truncateEnd(text, width) {
  if (displayWidth(text) <= width) return text;
  let kept = "";
  for (const char of text) {
    if (displayWidth(kept + char) > width - 1) break;
    kept += char;
  }
  return `${kept}…`;
}

// `text` (without color codes) cut to `width` columns, with … in place of its middle, which
// keeps a path's start and its file name.
export function truncateMiddle(text, width) {
  if (displayWidth(text) <= width) return text;
  const chars = [...text];
  let start = "";
  let end = "";
  for (let i = 0, j = chars.length - 1; i <= j; ) {
    if (displayWidth(start) <= displayWidth(end)) {
      if (displayWidth(start + chars[i] + end) > width - 1) break;
      start += chars[i++];
    } else {
      if (displayWidth(start + chars[j] + end) > width - 1) break;
      end = chars[j--] + end;
    }
  }
  return `${start}…${end}`;
}

// `text` padded with spaces to `width` columns.
export function padEnd(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Rows in a box with rounded corners, as lines. The box fits its widest row, plus 4 columns for
 * its border and padding; rows must be short enough for that to fit the terminal.
 */
export function box(rows, { g = glyphs, border = theme.muted } = {}) {
  const width = Math.max(0, ...rows.map(displayWidth));
  const [topLeft, topRight, bottomLeft, bottomRight] = g.corners;
  const line = g.rule.repeat(width + 2);
  return [
    border(`${topLeft}${line}${topRight}`),
    ...rows.map((row) => `${border(g.side)} ${padEnd(row, width)} ${border(g.side)}`),
    border(`${bottomLeft}${line}${bottomRight}`),
  ];
}

// A rule across `width` columns with `label` in it: "── label ──────────". A label too long
// for the rest of the rule leaves it out.
export function rule(label, width, { g = glyphs, style = theme.muted } = {}) {
  if (!label) return style(g.rule.repeat(width));
  const rest = width - displayWidth(label) - 4;
  return `${style(g.rule.repeat(2))} ${label}${rest > 0 ? ` ${style(g.rule.repeat(rest))}` : ""}`;
}
