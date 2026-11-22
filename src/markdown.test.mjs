import { describe, expect, it } from "vitest";
import { createMarkdownWriter, displayWidth, renderLine, renderTable } from "./markdown.mjs";

const SYNTAX = {
  keyword: (text) => `[K:${text}]`,
  string: (text) => `[S:${text}]`,
  number: (text) => `[N:${text}]`,
  comment: (text) => `[#:${text}]`,
};

const STYLES = {
  heading: (text) => `[H:${text}]`,
  code: (text) => `[C:${text}]`,
  bold: (text) => `[B:${text}]`,
  italic: (text) => `[I:${text}]`,
  strike: (text) => `[X:${text}]`,
  dim: (text) => `[D:${text}]`,
  marker: (text) => text,
  syntax: SYNTAX,
};

// What a terminal `columns` wide shows after `output`: text wraps at the edge, \r goes to the
// start of the row, ESC[nA moves up, ESC[J clears to the end of the screen.
function screen(output, columns) {
  const rows = [[]];
  let row = 0;
  let col = 0;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (char === "\x1b") {
      const [sequence, count, command] = /^\x1b\[(\d*)([AJ])/.exec(output.slice(i));
      if (command === "A") row = Math.max(0, row - Number(count || 1));
      else {
        rows[row].length = col;
        rows.length = row + 1;
      }
      i += sequence.length - 1;
    } else if (char === "\r") {
      col = 0;
    } else if (char === "\n") {
      rows[++row] ??= [];
      col = 0;
    } else {
      if (col >= columns) {
        rows[++row] ??= [];
        col = 0;
      }
      rows[row][col++] = char;
    }
  }
  return rows.map((cells) => Array.from(cells, (cell) => cell ?? " ").join("")).join("\n");
}

function writer({ columns = 80, enabled = true } = {}) {
  let output = "";
  const md = createMarkdownWriter({ write: (text) => (output += text), columns: () => columns, enabled, styles: STYLES });
  return { md, output: () => output, screen: () => screen(output, columns) };
}

describe("renderLine", () => {
  it("styles headings, code, bullets, quotes, rules, bold and links", () => {
    const render = (line, inCode = false) => renderLine(line, inCode, STYLES).text;
    expect(render("## Install `demo`")).toBe("[H:Install [C:demo]]");
    expect(render("- run **npm test** first")).toBe("• run [B:npm test] first");
    expect(render("  * nested")).toBe("  ◦ nested");
    const marked = { ...STYLES, marker: (text) => `[M:${text}]` };
    expect(renderLine("2. then *this*", false, marked).text).toBe("[M:2.] then [I:this]");
    expect(renderLine("10) ~~old~~ _new_", false, marked).text).toBe("[M:10)] [X:old] [I:new]");
    expect(renderLine("- item", false, marked).text).toBe("[M:•] item");
    expect(render("> a quote")).toBe("[D:│] a quote");
    expect(render("---")).toBe(`[D:${"─".repeat(20)}]`);
    expect(render("see [the docs](https://example.com/docs)")).toBe("see the docs [D:(https://example.com/docs)]");
    expect(render("no **markers** inside `a **b**`")).toBe("no [B:markers] inside [C:a **b**]");
    expect(render("snake_case and 2*3*4 stay")).toBe("snake_case and 2*3*4 stay");
    // With real colors, a style's codes have a "[" that mustn't start a link.
    const colors = { ...STYLES, bold: (text) => `\x1b[1m${text}\x1b[22m` };
    expect(renderLine("**fix** it, see [docs](https://example.com)", false, colors).text).toBe("\x1b[1mfix\x1b[22m it, see docs [D:(https://example.com)]");
    expect(render("# not a heading in code", true)).toBe("[C:# not a heading in code]");
    expect(renderLine("```js", false, STYLES)).toEqual({ text: "[D:```js]", inCode: { language: "js" } });
    expect(renderLine("```", false, STYLES)).toEqual({ text: "[D:```]", inCode: { language: null } });
    expect(renderLine("```", { language: "js" }, STYLES)).toEqual({ text: "[D:```]", inCode: false });
  });

  it("tells headings apart by level", () => {
    const styles = { ...STYLES, heading: (text, level) => `[H${level}:${text}]` };
    expect(renderLine("# Title", false, styles).text).toBe("[H1:Title]");
    expect(renderLine("### Part `x` ###", false, styles).text).toBe("[H3:Part [C:x]]");
  });

  it("colors code in a language it knows, and leaves other code one color", () => {
    expect(renderLine('const a = "b"; // c', { language: "js" }, STYLES).text).toBe('[K:const] a = [S:"b"]; [#:// c]');
    expect(renderLine("const a = 1;", { language: "brainfudge" }, STYLES).text).toBe("[C:const a = 1;]");
    expect(renderLine("const a = 1;", { language: null }, STYLES).text).toBe("[C:const a = 1;]");
  });
});

describe("renderTable", () => {
  const rows = ["| Name | Size |", "|:--|--:|", "| `a.js` | 12 |", "| b.js | 3 |"];

  it("draws a table in a box, its columns aligned", () => {
    // (The style markers count as text here: "[C:a.js]" makes the first column 8 wide.)
    expect(renderTable(rows, STYLES, 80).map((line) => line.replace(/\[D:([^\]]*)\]/g, "$1"))).toEqual([
      "┌──────────┬──────┐",
      "│ [B:Name    ] │ [B:Size] │",
      "├──────────┼──────┤",
      "│ [C:a.js] │   12 │",
      "│ b.js     │    3 │",
      "└──────────┴──────┘",
    ]);
  });

  it("leaves rows that aren't a table, or a table too wide for the terminal", () => {
    expect(renderTable(["| a | b |", "| c | d |"], STYLES, 80)).toBeNull();
    expect(renderTable(rows, STYLES, 10)).toBeNull();
  });
});

describe("displayWidth", () => {
  it("counts wide characters twice and combining marks not at all", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("🎉")).toBe(2);
  });
});

describe("createMarkdownWriter", () => {
  it("streams prose as it comes and redraws a line once its markdown is complete", () => {
    const { md, output, screen } = writer();
    md.write("Run `np");
    expect(output()).toBe("Run `np"); // shown right away
    md.write("m test` now.\nNext line");
    md.endLine();
    expect(screen()).toBe("Run [C:npm test] now.\nNext line\n");
  });

  it("holds a heading or code until its line ends, so their markers never show", () => {
    const { md, output, screen } = writer();
    for (const token of ["#", "# Ti", "tle\n", "``", "`js\n", "let a = 1;"]) md.write(token);
    expect(output()).not.toContain("#"); // not even the first "#", before it was clear what it starts
    expect(output()).not.toContain("let"); // code shows a whole line at a time, colored
    for (const token of ["\n", "```\n", "done"]) md.write(token);
    md.endLine();
    expect(screen()).toBe("[H:Title]\n[D:```js]\n[K:let] a = [N:1];\n[D:```]\ndone\n");
  });

  it("holds a table until it ends, and draws it in a box", () => {
    const { md, output, screen } = writer();
    md.write("Sizes:\n\n| Name | Size |\n|---|---|\n| a.js | 12 |\n");
    expect(output()).not.toContain("a.js");
    md.write("\nDone.");
    md.endLine();
    expect(screen().replace(/\[D:([^\]]*)\]/g, "$1")).toBe(
      ["Sizes:", "", "┌──────┬──────┐", "│ [B:Name] │ [B:Size] │", "├──────┼──────┤", "│ a.js │ 12   │", "└──────┴──────┘", "", "Done.", ""].join("\n"),
    );
  });

  it("draws a table that ends the reply", () => {
    const { md, output } = writer();
    md.write("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(output()).toBe("");
    md.endLine();
    expect(output().replace(/\[D:([^\]]*)\]/g, "$1")).toBe("┌───┬───┐\n│ [B:a] │ [B:b] │\n├───┼───┤\n│ 1 │ 2 │\n└───┴───┘\n");
  });

  it("leaves out blank lines at the start and end, and more than one in a row outside code", () => {
    const { md, output } = writer();
    md.write("\n\nOne\n\n\n\nTwo\n```\na\n\n\nb\n```\n\n\n");
    md.endLine();
    expect(output()).toBe("One\n\nTwo\n[D:```]\n[C:a]\n\n\n[C:b]\n[D:```]\n");
  });

  it("starts a new reply outside any code block", () => {
    const { md, screen } = writer();
    md.write("```\nnever closed\n");
    md.endLine();
    md.reset();
    md.write("**prose**\n");
    md.endLine();
    expect(screen()).toBe("[D:```]\n[C:never closed]\n[B:prose]\n");
  });

  it("redraws a line that wrapped onto several rows", () => {
    // Shown as it came, the line took three rows; rendered, it takes three different ones.
    const { md, screen } = writer({ columns: 10 });
    md.write("a **bold** word that wraps\nok\n");
    md.endLine();
    expect(screen()).toBe("a [B:bold]\n word that\n wraps\nok\n");
  });

  it("writes as it is when it is off, or for plain text", () => {
    const off = writer({ enabled: false });
    off.md.write("# Title\n**bold**");
    off.md.endLine();
    expect(off.output()).toBe("# Title\n**bold**\n");

    const { md, output } = writer();
    md.write("## Hea");
    md.write("dim summary", { plain: true }); // shows the held heading first
    md.endLine();
    expect(output()).toBe("[H:Hea]dim summary\n");
  });

  it("starts a line of its own after other output", () => {
    const { md, output } = writer();
    md.write("Looking at the files");
    md.endLine();
    md.endLine(); // nothing more to end
    md.write("## Done\n");
    md.endLine();
    expect(output()).toBe("Looking at the files\n[H:Done]\n");
  });
});
