import chalk from "chalk";

const INTERVAL_MS = 100;
const UNICODE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_FRAMES = ["-", "\\", "|", "/"];

// The old Windows console can't draw the braille frames; Windows Terminal and VS Code can.
export function defaultFrames(env = process.env, platform = process.platform) {
  return platform !== "win32" || env.WT_SESSION || env.TERM_PROGRAM === "vscode" ? UNICODE_FRAMES : ASCII_FRAMES;
}

/**
 * A one-line spinner with the elapsed time, like "⠙ Thinking · 4s", for while the agent waits
 * on the model or a tool. It shows only in a terminal, from its first tick on (so quick steps
 * don't flash), and not while `paused()` is true, like while the user is typing.
 * Anything else written to the terminal must erase() it first; it comes back on the next tick.
 */
export function createStatus({
  output = process.stdout,
  paused = () => false,
  now = Date.now,
  frames = defaultFrames(),
  interval = INTERVAL_MS,
} = {}) {
  const enabled = Boolean(output.isTTY);
  let text = null;
  let started = 0;
  let frame = 0;
  let timer = null;
  let visible = false;

  function erase() {
    if (!visible) return;
    output.write("\r\x1b[2K");
    visible = false;
  }

  function render() {
    if (paused()) return erase();
    const seconds = Math.floor((now() - started) / 1000);
    let line = `${frames[frame++ % frames.length]} ${text}${seconds ? ` · ${seconds}s` : ""}`;
    // A line that wraps can't be erased with one "clear line".
    const width = (output.columns || 80) - 1;
    if (line.length > width) line = `${line.slice(0, width - 1)}…`;
    output.write(`\r\x1b[2K${chalk.dim(line)}`);
    visible = true;
  }

  return {
    enabled,
    /** Shows `newText`, keeping the elapsed time if the status is already showing. */
    set(newText) {
      if (!enabled) return;
      if (text === null) {
        started = now();
        frame = 0;
        timer = setInterval(render, interval);
        timer.unref?.();
      }
      text = newText;
    },
    /** Takes the status off the screen until its next tick, to write something else. */
    erase,
    /** Ends the status: what it was waiting on is over. */
    stop() {
      clearInterval(timer);
      timer = null;
      text = null;
      erase();
    },
  };
}
