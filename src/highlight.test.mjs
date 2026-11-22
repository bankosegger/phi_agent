import { describe, expect, it } from "vitest";
import { canHighlight, highlight } from "./highlight.mjs";

const STYLES = {
  keyword: (text) => `[K:${text}]`,
  string: (text) => `[S:${text}]`,
  number: (text) => `[N:${text}]`,
  comment: (text) => `[#:${text}]`,
  key: (text) => `[Y:${text}]`,
  variable: (text) => `[V:${text}]`,
  added: (text) => `[+:${text}]`,
  removed: (text) => `[-:${text}]`,
  meta: (text) => `[M:${text}]`,
  prompt: (text) => `[P:${text}]`,
};
const color = (line, language) => highlight(line, language, STYLES);

describe("highlight", () => {
  it("colors keywords, strings, numbers and comments in JavaScript and TypeScript", () => {
    expect(color('export const url = "http://x"; // the "home" page', "js")).toBe('[K:export] [K:const] url = [S:"http://x"]; [#:// the "home" page]');
    expect(color("if (a === 0x1F) return `${b}`;", "ts")).toBe("[K:if] (a === [N:0x1F]) [K:return] [S:`${b}`];");
    expect(color("let n = 1.5e3 /* why */ + 2;", "javascript")).toBe("[K:let] n = [N:1.5e3] [#:/* why */] + [N:2];");
    // A line inside a doc comment, and words that only contain keywords.
    expect(color(" * @param iffy the input", "js")).toBe("[#: * @param iffy the input]");
    expect(color("const constant = format(x);", "js")).toBe("[K:const] constant = format(x);");
  });

  it("knows comments by language: # in Python and shells, -- in SQL", () => {
    expect(color("def f(x):  # a 'note'", "python")).toBe("[K:def] f(x):  [#:# a 'note']");
    expect(color("SELECT name FROM users -- all", "sql")).toBe("[K:SELECT] name [K:FROM] users [#:-- all]");
    // In a shell, # starts a comment only after a space, and $# is a variable.
    expect(color('echo "$HOME" $# a#b # done', "bash")).toBe('echo [S:"$HOME"] [V:$#] a#b [#:# done]');
    expect(color("for f in *.js; do echo ${f}; done", "sh")).toBe("[K:for] f [K:in] *.js; [K:do] echo [V:${f}]; [K:done]");
  });

  it("colors JSON keys apart from values, and YAML and TOML keys", () => {
    expect(color('  "name": "demo", "port": 8080, "ok": true', "json")).toBe('  [Y:"name"]: [S:"demo"], [Y:"port"]: [N:8080], [Y:"ok"]: [K:true]');
    expect(color("  - name: build # step", "yaml")).toBe("  - [Y:name]: build [#:# step]");
    expect(color('version = "1.0"', "toml")).toBe('[Y:version] = [S:"1.0"]');
    expect(color("[tool.ruff]", "toml")).toBe("[Y:[tool.ruff]]");
  });

  it("colors diffs and shell sessions by line", () => {
    expect(color("+added", "diff")).toBe("[+:+added]");
    expect(color("-removed", "diff")).toBe("[-:-removed]");
    expect(color("@@ -1,2 +1,3 @@", "patch")).toBe("[M:@@ -1,2 +1,3 @@]");
    expect(color("--- a/file.js", "diff")).toBe("[M:--- a/file.js]");
    expect(color(" context", "diff")).toBe(" context");
    expect(color("$ npm test # all", "console")).toBe("[P:$ ]npm test [#:# all]");
    expect(color("1 test passed", "console")).toBe("1 test passed");
  });

  it("leaves languages it doesn't know as they are", () => {
    expect(canHighlight("JS")).toBe(true);
    expect(canHighlight("rust")).toBe(true);
    expect(canHighlight("brainfudge")).toBe(false);
    expect(canHighlight(null)).toBe(false);
    expect(color("const a = 1;", "brainfudge")).toBe("const a = 1;");
  });
});
