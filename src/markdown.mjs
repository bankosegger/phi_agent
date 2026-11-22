import chalk from "chalk";
import { SYNTAX_STYLES, canHighlight, highlight } from "./highlight.mjs";
import { displayWidth } from "./theme.mjs";

export { displayWidth };

// Shows the model's markdown replies in a terminal as they stream in: headings in bold, code in
// color, bullets as •, tables in boxes, links as their text and a dimmed URL. Prose appears as
// it comes, and a line with markdown in it is redrawn once it is complete; a heading, a line of
// code or a table row waits for its line to end, so it never shows its markers.

const FENCE = /^\s{0,3}(```|~~~)/;
const FENCE_LINE = /^\s{0,3}(?:```|~~~)\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
// The start of a line that may still turn out to be a heading or a fence.
const UNDECIDED = /^\s{0,3}(#{1,6}|`{1,2}|~{1,2})?$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s{0,3}\|/;
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;

export const DEFAULT_STYLES = {
  heading: (text, level = 2) => (level === 1 ? chalk.bold.underline.cyan(text) : level === 2 ? chalk.bold.cyan(text) : chalk.bold(text)),
  code: (text) => chalk.cyan(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strike: (text) => chalk.strikethrough(text),
  dim: (text) => chalk.dim(text),
  marker: (text) => chalk.cyan(text),
  syntax: SYNTAX_STYLES,
};

// Inline markdown: `code`, **bold** or __bold__, ~~struck~~, *italic* or _italic_, and
// [links](url), found in one pass from the left, so that nothing inside a code span is styled,
// and no style's color codes are read as markdown (their "[" as the start of a link, say).
// A * or _ inside a word, as in 2*3*4 or snake_case, is not markdown.
const INLINE =
  /`([^`]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|~~(?=\S)(.+?)(?<=\S)~~|(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])|\[([^\][]+)\]\(([^)\s]+)\)/g;

function inline(text, styles) {
  return text.replace(INLINE, (match, code, bold, underscored, struck, starred, italic, label, url) => {
    if (code != null) return styles.code(code);
    if (bold != null || underscored != null) return styles.bold(bold ?? underscored);
    if (struck != null) return styles.strike(struck);
    if (starred != null || italic != null) return styles.italic(starred ?? italic);
    return `${label} ${styles.dim(`(${url})`)}`;
  });
}

function codeLine(line, language, styles) {
  if (!line) return "";
  return language && canHighlight(language) ? highlight(line, language, styles.syntax) : styles.code(line);
}

/**
 * How one line of markdown looks in the terminal, given whether it is inside a code block:
 * false, or { language } (true for one without a language). Returns { text, inCode } with
 * whether the next line is.
 */
export function renderLine(line, inCode, styles = DEFAULT_STYLES) {
  const s = { ...DEFAULT_STYLES, ...styles };
  const fence = line.match(FENCE_LINE);
  if (fence) return { text: s.dim(line), inCode: inCode ? false : { language: fence[1] || null } };
  if (inCode) return { text: codeLine(line, inCode.language, s), inCode };
  const heading = line.match(HEADING);
  if (heading) return { text: s.heading(inline(heading[2], s), heading[1].length), inCode };
  if (RULE.test(line)) return { text: s.dim("─".repeat(20)), inCode };
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return { text: `${bullet[1]}${s.marker(bullet[1].length >= 2 ? "◦" : "•")} ${inline(bullet[2], s)}`, inCode };
  const numbered = line.match(/^(\s*)(\d{1,3}[.)])\s+(.*)$/);
  if (numbered) return { text: `${numbered[1]}${s.marker(numbered[2])} ${inline(numbered[3], s)}`, inCode };
  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) return { text: `${quote[1]}${s.dim("│")} ${inline(quote[2], s)}`, inCode };
  return { text: inline(line, s), inCode };
}

// A table row's cells: "| a | b \| c |" has "a" and "b | c".
function tableCells(row) {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * A markdown table (its rows, as lines) drawn with box lines, as lines no wider than `width`.
 * Null if the rows aren't a table, or it wouldn't fit.
 */
export function renderTable(rows, styles = DEFAULT_STYLES, width = 80) {
  const s = { ...DEFAULT_STYLES, ...styles };
  if (rows.length < 2) return null;
  const separator = tableCells(rows[1]);
  if (!separator.every((cell) => TABLE_SEPARATOR_CELL.test(cell))) return null;

  const align = separator.map((cell) => (cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left"));
  const table = [rows[0], ...rows.slice(2)].map((row) => {
    const cells = tableCells(row);
    return separator.map((_, i) => inline(cells[i] ?? "", s));
  });
  const widths = separator.map((_, i) => Math.max(1, ...table.map((cells) => displayWidth(cells[i]))));
  if (widths.reduce((sum, cellWidth) => sum + cellWidth + 3, 1) > width) return null;

  const pad = (text, i) => {
    const space = widths[i] - displayWidth(text);
    const left = align[i] === "right" ? space : align[i] === "center" ? Math.floor(space / 2) : 0;
    return " ".repeat(left) + text + " ".repeat(space - left);
  };
  const border = (left, middle, right) => s.dim(left + widths.map((cellWidth) => "─".repeat(cellWidth + 2)).join(middle) + right);
  const line = (cells, style = (text) => text) => s.dim("│") + cells.map((cell, i) => ` ${style(pad(cell, i))} `).join(s.dim("│")) + s.dim("│");
  return [border("┌", "┬", "┐"), line(table[0], s.bold), border("├", "┼", "┤"), ...table.slice(1).map((cells) => line(cells)), border("└", "┴", "┘")];
}

/**
 * Writes streamed markdown to a terminal through `write`, rendered (see renderLine) unless
 * `enabled` is false, when the text goes out as it comes. `columns()` is the terminal's width,
 * for redrawing lines that wrapped. Before other output, endLine() finishes the line in
 * progress, showing anything held back of it.
 *
 * Line breaks are written when the text after them comes, so a reply never starts or ends
 * with blank lines, and has no more than one blank line in a row outside code.
 */
export function createMarkdownWriter({ write, columns = () => 80, enabled = true, styles = DEFAULT_STYLES }) {
  const s = { ...DEFAULT_STYLES, ...styles };
  let code = false; // false, or { language } inside a code block
  let line = ""; // the current line so far
  let shown = 0; // how much of it is on the screen, as it came
  let lineStart = true; // whether `line` began a line (and so can be a heading, say)
  let breaks = 0; // line breaks not written yet
  let started = false; // whether text was written since the last endLine (so the cursor is after it)
  let table = []; // the rows of a table, held until it ends

  // Writes text that has no line breaks, after the breaks before it.
  function emit(text) {
    if (!text) return;
    if (breaks && started) write("\n".repeat(code ? breaks : Math.min(breaks, 2)));
    breaks = 0;
    write(text);
    started = true;
  }

  function flushTable() {
    if (!table.length) return;
    const rows = table;
    table = [];
    for (const text of renderTable(rows, s, columns()) ?? rows.map((row) => inline(row, s))) {
      emit(text);
      breaks = 1;
    }
  }

  // Draws the current line rendered: over what is on the screen of it, if anything.
  function drawLine() {
    const { text, inCode: next } = lineStart ? renderLine(line, code, s) : { text: inline(line, s), inCode: code };
    if (!shown) {
      emit(text);
    } else if (text !== line && !line.includes("\t")) {
      const rows = Math.max(1, Math.ceil(displayWidth(line) / Math.max(1, columns())));
      write(`\r${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b[J${text}`);
    }
    code = next;
    line = "";
    shown = 0;
  }

  return {
    // Writes streamed text: as markdown, or as it is if `plain`.
    write(text, { plain = false } = {}) {
      if (!text) return;
      if (!enabled || plain) {
        flushTable();
        if (line || shown) drawLine();
        for (const part of text.split(/(\n)/)) {
          if (part === "\n") breaks++;
          else emit(part);
        }
        lineStart = breaks > 0;
        return;
      }

      for (const part of text.split(/(\n)/)) {
        if (part === "\n") {
          if (lineStart && !code && TABLE_ROW.test(line)) {
            table.push(line);
            line = "";
          } else {
            flushTable();
            drawLine();
            breaks++;
          }
          lineStart = true;
        } else if (part) {
          line += part;
          // A heading, a fence, code or a table row is held until its line ends; so is a start
          // that may still turn into one.
          const held =
            lineStart && (code || FENCE.test(line) || HEADING.test(line) || TABLE_ROW.test(line) || (!shown && UNDECIDED.test(line)));
          if (!held) {
            flushTable();
            emit(line.slice(shown));
            shown = line.length;
          }
        }
      }
    },

    // Finishes the line in progress, if any, so that other output starts on a line of its own.
    endLine() {
      flushTable();
      if (line || shown) drawLine();
      if (started) write("\n");
      started = false;
      breaks = 0;
      lineStart = true;
    },

    // Forgets an open code block: the next text is a new reply.
    reset() {
      code = false;
    },
  };
}
