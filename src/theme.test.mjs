import { describe, expect, it } from "vitest";
import { stripVTControlCharacters as plain } from "node:util";
import { LEGACY_GLYPHS, UNICODE_GLYPHS, box, displayWidth, padEnd, rule, supportsUnicode, truncateEnd, truncateMiddle } from "./theme.mjs";

describe("supportsUnicode", () => {
  it("is false only in the old Windows console and the Linux console", () => {
    expect(supportsUnicode({}, "win32")).toBe(false);
    expect(supportsUnicode({ WT_SESSION: "1" }, "win32")).toBe(true);
    expect(supportsUnicode({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
    expect(supportsUnicode({ TERM: "xterm-256color" }, "win32")).toBe(true);
    expect(supportsUnicode({}, "darwin")).toBe(true);
    expect(supportsUnicode({ TERM: "xterm-256color" }, "linux")).toBe(true);
    expect(supportsUnicode({ TERM: "linux" }, "linux")).toBe(false);
  });

  it("has simpler symbols for the old Windows console", () => {
    expect(UNICODE_GLYPHS.prompt).toBe("❯");
    expect(LEGACY_GLYPHS.prompt).toBe(">");
    expect(LEGACY_GLYPHS.corners).toEqual(["┌", "┐", "└", "┘"]);
  });
});

describe("text width", () => {
  it("counts columns, not characters or color codes", () => {
    expect(displayWidth("\x1b[36mab\x1b[39m")).toBe(2);
    expect(displayWidth("日本")).toBe(4);
    expect(padEnd("\x1b[1mab\x1b[22m", 4)).toBe("\x1b[1mab\x1b[22m  ");
  });

  it("cuts text to a width, at its end or in its middle", () => {
    expect(truncateEnd("abcdef", 4)).toBe("abc…");
    expect(truncateEnd("abc", 4)).toBe("abc");
    expect(truncateEnd("日本語", 4)).toBe("日…");

    const path = "C:/Users/me/projects/app/src/index.js";
    const cut = truncateMiddle(path, 20);
    expect(displayWidth(cut)).toBeLessThanOrEqual(20);
    expect(cut).toMatch(/^C:\/Users.*….*index\.js$/);
    expect(truncateMiddle("short", 20)).toBe("short");
  });
});

describe("box and rule", () => {
  it("draws a box around rows, as wide as the widest", () => {
    expect(box(["ab", "\x1b[1mc\x1b[22m"], { g: UNICODE_GLYPHS }).map(plain)).toEqual(["╭────╮", "│ ab │", "│ c  │", "╰────╯"]);
    expect(box(["ab"], { g: LEGACY_GLYPHS }).map(plain)).toEqual(["┌────┐", "│ ab │", "└────┘"]);
  });

  it("draws a rule with a label across a width", () => {
    expect(plain(rule("hi", 10, { g: UNICODE_GLYPHS }))).toBe("── hi ────");
    expect(plain(rule("", 5, { g: UNICODE_GLYPHS }))).toBe("─────");
    // A label too long for the width keeps only the start of the rule.
    expect(plain(rule("a long label", 10, { g: UNICODE_GLYPHS }))).toBe("── a long label");
  });
});
