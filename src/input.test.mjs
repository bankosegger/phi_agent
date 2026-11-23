import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters as plain } from "node:util";
import { createInput } from "./input.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A reader on fake streams. In terminal mode, "\r" is the Enter key.
function setup({ terminal }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const queued = [];
  let shown = "";
  output.setEncoding("utf8").on("data", (text) => (shown += text));

  const reader = createInput({ input, output, terminal, pasteWindowMs: 20, onQueued: (text) => queued.push(text) });
  return { input, reader, queued, shown: () => shown };
}

describe("createInput in a terminal", () => {
  it("makes pasted lines one input", async () => {
    const { input, reader } = setup({ terminal: true });
    const next = reader.next(": ");
    input.write("fix this:\rTypeError: x is undefined\r    at main (app.js:3:5)\r");

    expect(await next).toBe("fix this:\nTypeError: x is undefined\n    at main (app.js:3:5)");
    reader.close();
  });

  it("keeps the last line of a paste that has no final line break", async () => {
    const { input, reader } = setup({ terminal: true });
    const next = reader.next(": ");
    input.write("one\rtwo");

    expect(await next).toBe("one\ntwo");
    // Nothing is left over to end up in the next input.
    const after = reader.next(": ");
    input.write("three\r");
    expect(await after).toBe("three");
    reader.close();
  });

  it("keeps lines entered apart separate, and queues those entered while busy", async () => {
    const { input, reader, queued, shown } = setup({ terminal: true });
    const first = reader.next(": ");
    input.write("first\r");
    expect(await first).toBe("first");

    // Nothing asks for input while the agent works on "first".
    await wait(40);
    input.write("second\r");
    await wait(40);
    expect(queued).toEqual(["second"]);

    expect(await reader.next(": ")).toBe("second");
    expect(shown()).toContain(": second\n"); // shown again when it runs
    reader.close();
  });

  it("joins lines ended with \\ into one input, also while busy", async () => {
    const { input, reader, queued } = setup({ terminal: true });

    // Nothing asks for input while the agent works: the lines still queue as one.
    input.write("first \\\r");
    await wait(40);
    input.write("second\r");
    await wait(40);
    expect(queued).toEqual(["first \nsecond"]);
    expect(await reader.next(": ")).toBe("first \nsecond");
    reader.close();
  });

  it("answers a confirmation with a new line, not one entered earlier", async () => {
    const { input, reader } = setup({ terminal: true });
    input.write("later task\r");
    await wait(40);

    const answer = reader.ask("[confirm] ");
    input.write("y\r");
    expect(await answer).toBe("y");
    expect(await reader.next(": ")).toBe("later task");
    reader.close();
  });

  it("gives up a question when its signal aborts", async () => {
    const { reader } = setup({ terminal: true });
    const controller = new AbortController();
    const answer = reader.ask("[confirm] ", controller.signal);
    controller.abort();

    expect(await answer).toBe(null);
    reader.close();
  });

  it("remembers what was entered, but not answers to questions", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const saved = [];
    const reader = createInput({ input, output, terminal: true, pasteWindowMs: 20, history: ["older task"], onHistory: (lines) => saved.push([...lines]) });

    const next = reader.next(": ");
    input.write("run the tests\r");
    expect(await next).toBe("run the tests");
    const answer = reader.ask("[confirm] ");
    input.write("y\r");
    expect(await answer).toBe("y");

    expect(saved.at(-1)).toEqual(["run the tests", "older task"]);
    // The up arrow brings back the last task, not the answer.
    const again = reader.next(": ");
    input.write("\x1b[A\r");
    expect(await again).toBe("run the tests");

    // A paste is one input, and none of its lines go into the history.
    const pasted = reader.next(": ");
    input.write("Error: boom\r  at app.js:1\r");
    expect(await pasted).toBe("Error: boom\n  at app.js:1");
    expect(saved.at(-1)).toEqual(["run the tests", "older task"]);
    reader.close();
  });

  it("goes on to the next line after a line typed with \\ at its end", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.setEncoding("utf8").on("data", (text) => (shown += text));
    const saved = [];
    const reader = createInput({ input, output, terminal: true, pasteWindowMs: 20, continuationPrompt: "… ", onHistory: (lines) => saved.push([...lines]) });

    // Typed lines, each entered on its own.
    const next = reader.next(": ");
    input.write("fix the parser \\\r");
    await wait(40);
    expect(plain(shown)).toMatch(/… $/); // the next line's prompt
    input.write("\\\r");
    await wait(40);
    input.write("and its tests\r");
    expect(await next).toBe("fix the parser \n\nand its tests");
    // None of its lines go into the history.
    expect(saved.at(-1) ?? []).toEqual([]);

    // A pasted line ending with \ stays as it is.
    const pasted = reader.next(": ");
    input.write("cd C:\\work\\\rdir\r");
    expect(await pasted).toBe("cd C:\\work\\\ndir");
    reader.close();
  });

  it("throws away what was typed at the prompt, when asked to", async () => {
    const { input, reader, shown } = setup({ terminal: true });
    expect(reader.discardDraft()).toBe(false); // nothing typed

    const next = reader.next(": ");
    input.write("first line \\\r");
    await wait(40);
    input.write("half");
    await wait(0);
    expect(reader.discardDraft()).toBe(true);
    expect(reader.typing).toBe(false);
    expect(plain(shown())).toMatch(/: $/); // the prompt again

    input.write("something else\r");
    expect(await next).toBe("something else");
    reader.close();
  });

  it("completes the line on Tab", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const reader = createInput({ input, output, terminal: true, pasteWindowMs: 20, completer: (line) => [["/compact"], line] });

    // Keys one at a time, as typed: in one piece, they would read as a paste.
    const next = reader.next(": ");
    input.write("/comp");
    await wait(30);
    input.write("\t");
    await wait(30);
    input.write("\r");
    expect(await next).toBe("/compact");
    reader.close();
  });

  it("says when the user is typing, and runs a handler before each key is shown", async () => {
    const { input, reader, shown } = setup({ terminal: true });
    const keys = [];
    reader.beforeKeypress((key) => keys.push([key, reader.typing, shown().length]));

    expect(reader.typing).toBe(false);
    input.write("a");
    input.write("b");
    await wait(0);
    expect(reader.typing).toBe(true);
    // Each handler ran before its key was added to the line and echoed.
    expect(keys.map(([key, typing]) => [key, typing])).toEqual([["a", false], ["b", true]]);
    expect(keys[1][2]).toBeLessThan(shown().length);

    input.write("\r");
    await wait(40);
    expect(reader.typing).toBe(false);
    expect(await reader.next(": ")).toBe("ab");
    reader.close();
  });
});

describe("createInput's history search, with Ctrl+R", () => {
  const CTRL_R = "\x12";
  const CTRL_G = "\x07";
  const CTRL_C = "\x03";
  const LEFT = "\x1b[D";
  // Newest first, as readline keeps it.
  const history = ["run the tests", "fix the parser bug", "explain the build", "Fix the PARSER warnings"];

  function setupSearch() {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.setEncoding("utf8").on("data", (text) => (shown += text));
    const searchPrompt = (query, { found }) => `(${found ? "search" : "no match"}: ${query}) `;
    const reader = createInput({ input, output, terminal: true, pasteWindowMs: 20, history, searchPrompt });
    // What the terminal shows last: the prompt and line, as readline draws them again on each key,
    // after moving the cursor to the start of the line (ESC[1G).
    const showing = () => plain(shown.split(/\x1b\[1G|[\r\n]/).filter(Boolean).at(-1) ?? "");
    return { input, reader, showing };
  }

  it("finds the newest line with what is typed, in any case, and enters it", async () => {
    const { input, reader, showing } = setupSearch();
    const next = reader.next(": ");
    input.write(`${CTRL_R}`);
    await wait(0);
    expect(showing()).toBe("(search: ) ");
    input.write("PARS");
    await wait(0);
    expect(showing()).toBe("(search: PARS) fix the parser bug");

    // A query no line has keeps the line found last; taking a letter back finds lines again.
    input.write("x");
    await wait(0);
    expect(showing()).toBe("(no match: PARSx) fix the parser bug");
    input.write("\x7f"); // backspace
    await wait(0);
    expect(showing()).toBe("(search: PARS) fix the parser bug");

    input.write("\r");
    expect(await next).toBe("fix the parser bug");
    reader.close();
  });

  it("finds older lines with Ctrl+R again, up to the oldest", async () => {
    const { input, reader, showing } = setupSearch();
    const next = reader.next(": ");
    input.write(`${CTRL_R}parser${CTRL_R}`);
    await wait(0);
    expect(showing()).toBe("(search: parser) Fix the PARSER warnings");
    input.write(CTRL_R);
    await wait(0);
    expect(showing()).toBe("(no match: parser) Fix the PARSER warnings");
    input.write("\r");
    expect(await next).toBe("Fix the PARSER warnings");
    reader.close();
  });

  it("goes back to what was typed with Ctrl+G, Ctrl+C or Esc, and Ctrl+C doesn't interrupt", async () => {
    const { input, reader, showing } = setupSearch();
    const interrupts = [];
    reader.onInterrupt(() => interrupts.push("Ctrl+C"));
    const next = reader.next(": ");
    input.write(`my draft${CTRL_R}build`);
    await wait(0);
    expect(showing()).toBe("(search: build) explain the build");

    input.write(CTRL_G);
    await wait(0);
    expect(showing()).toBe(": my draft");
    input.write(`${CTRL_R}tests${CTRL_C}`);
    await wait(0);
    expect(showing()).toBe(": my draft");
    expect(interrupts).toEqual([]);
    // A lone Esc is told apart from the start of an arrow key after a moment.
    input.write(`${CTRL_R}tests\x1b`);
    await wait(600);
    expect(showing()).toBe(": my draft");

    input.write("!\r");
    expect(await next).toBe("my draft!");
    reader.close();
  });

  it("keeps the line found to edit, with Tab or an arrow key", async () => {
    const { input, reader } = setupSearch();
    const first = reader.next(": ");
    input.write(`${CTRL_R}explain\t again\r`);
    expect(await first).toBe("explain the build again");

    // An arrow key moves the cursor in the line found, as it would in a line typed.
    const second = reader.next(": ");
    input.write(`${CTRL_R}run${LEFT}X\r`);
    expect(await second).toBe("run the testXs");
    reader.close();
  });

  it("goes on with a search started while the agent worked, and leaves questions alone", async () => {
    const { input, reader, showing } = setupSearch();
    input.write(`${CTRL_R}build`);
    await wait(0);
    // The next prompt comes while searching: the search stays, and ends with that prompt.
    const next = reader.next(": ");
    await wait(0);
    expect(showing()).toBe("(search: build) explain the build");
    input.write(CTRL_G);
    await wait(0);
    expect(showing()).toBe(": ");
    input.write("\r");
    expect(await next).toBe("");

    // At a question, Ctrl+R doesn't search: the answer is what is typed.
    const answer = reader.ask("[confirm] ");
    input.write(`${CTRL_R}y\r`);
    expect(await answer).toBe("y");
    reader.close();
  });
});

describe("createInput with piped input", () => {
  it("reads a line per input, answers questions in order, and ends with null", async () => {
    const { input, reader, queued } = setup({ terminal: false });
    input.write("task one\ny\ntask two\n");

    expect(await reader.next(": ")).toBe("task one");
    expect(await reader.ask("[confirm] ")).toBe("y");
    expect(await reader.next(": ")).toBe("task two");
    expect(queued).toEqual([]); // lines read ahead from a pipe are not announced

    const last = reader.next(": ");
    input.end();
    expect(await last).toBe(null);
    expect(await reader.next(": ")).toBe(null);
  });

  it("shows each input after its prompt, as a terminal would", async () => {
    const { input, reader, shown } = setup({ terminal: false });

    const task = reader.next(": ");
    input.write("task\n");
    expect(await task).toBe("task");

    const answer = reader.ask("[confirm] ");
    input.write("n\n");
    expect(await answer).toBe("n");

    expect(shown()).toBe(": task\n[confirm] n\n");
    reader.close();
  });
});
