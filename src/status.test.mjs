import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStatus, defaultFrames } from "./status.mjs";

const CLEAR = "\r\x1b[2K";

function fakeTerminal({ isTTY = true, columns = 40 } = {}) {
  const writes = [];
  return { isTTY, columns, writes, write: (text) => writes.push(text) };
}

// What the status line shows after the last write, without colors.
function shown(terminal) {
  return terminal.writes.at(-1).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace("\r", "");
}

describe("createStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a spinner with the elapsed time from its first tick, until stopped", () => {
    const terminal = fakeTerminal();
    let clock = 0;
    const status = createStatus({ output: terminal, now: () => clock, frames: ["a", "b"] });

    status.set("Thinking");
    expect(terminal.writes).toEqual([]); // quick steps never show
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Thinking");

    clock = 2500;
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("b Thinking · 2s");

    status.set("Writing src/a.js"); // the same wait goes on: the time keeps counting
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Writing src/a.js · 2s");

    status.stop();
    expect(terminal.writes.at(-1)).toBe(CLEAR);
    const count = terminal.writes.length;
    vi.advanceTimersByTime(1000);
    expect(terminal.writes).toHaveLength(count);

    status.set("Running the command"); // a new wait starts from 0s
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Running the command");
  });

  it("steps aside for other output, and while paused", () => {
    const terminal = fakeTerminal();
    let typing = false;
    const status = createStatus({ output: terminal, paused: () => typing, now: () => 0, frames: ["a"] });
    status.set("Thinking");
    vi.advanceTimersByTime(100);

    status.erase();
    status.erase(); // nothing left to clear
    expect(terminal.writes.filter((text) => text === CLEAR)).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Thinking"); // back on the next tick

    typing = true;
    vi.advanceTimersByTime(100);
    expect(terminal.writes.at(-1)).toBe(CLEAR);
    const count = terminal.writes.length;
    vi.advanceTimersByTime(500);
    expect(terminal.writes).toHaveLength(count); // stays away while the user types

    typing = false;
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Thinking");
    status.stop();
  });

  it("cuts a line that would wrap", () => {
    const terminal = fakeTerminal({ columns: 12 });
    const status = createStatus({ output: terminal, now: () => 0, frames: ["a"] });
    status.set("Writing src/very/long/path.js");
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Writing …");
    status.stop();
  });

  it("adds a hint once a wait goes on, if there is room for it", () => {
    const terminal = fakeTerminal({ columns: 60 });
    let clock = 0;
    const status = createStatus({ output: terminal, now: () => clock, frames: ["a"], hint: "Ctrl+C to cancel", hintAfter: 3000 });
    status.set("Thinking");
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Thinking");

    clock = 3000;
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Thinking · 3s · Ctrl+C to cancel");

    terminal.columns = 25;
    vi.advanceTimersByTime(100);
    expect(shown(terminal)).toBe("a Thinking · 3s");
    status.stop();
  });

  it("shows nothing outside a terminal", () => {
    const terminal = fakeTerminal({ isTTY: false });
    const status = createStatus({ output: terminal });
    expect(status.enabled).toBe(false);
    status.set("Thinking");
    vi.advanceTimersByTime(1000);
    status.erase();
    status.stop();
    expect(terminal.writes).toEqual([]);
  });

  it("uses plain frames in the old Windows console", () => {
    expect(defaultFrames({}, "win32")).toEqual(["-", "\\", "|", "/"]);
    expect(defaultFrames({ WT_SESSION: "1" }, "win32")[0]).toBe("⠋");
    expect(defaultFrames({ TERM_PROGRAM: "vscode" }, "win32")[0]).toBe("⠋");
    expect(defaultFrames({}, "linux")[0]).toBe("⠋");
  });
});
