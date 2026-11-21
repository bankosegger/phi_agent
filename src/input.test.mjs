import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
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
