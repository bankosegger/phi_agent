import { LEGACY_GLYPHS, UNICODE_GLYPHS, displayWidth, supportsUnicode, theme, truncateEnd } from "./theme.mjs";

const INTERVAL_MS = 100;

// The old Windows console can't draw the braille frames; Windows Terminal and VS Code can.
export function defaultFrames(env = process.env, platform = process.platform) {
  return (supportsUnicode(env, platform) ? UNICODE_GLYPHS : LEGACY_GLYPHS).spinner;
}

/**
 * A one-line spinner with the elapsed time, like "⠙ Thinking · 4s", for while the agent waits
 * on the model or a tool. It shows only in a terminal, from its first tick on (so quick steps
 * don't flash), and not while `paused()` is true, like while the user is typing. After
 * `hintAfter` ms of the same wait, it adds `hint`, like how to cancel.
 * Anything else written to the terminal must erase() it first; it comes back on the next tick.
 */
export function createStatus({
  output = process.stdout,
  paused = () => false,
  now = Date.now,
  frames = defaultFrames(),
  interval = INTERVAL_MS,
  hint = null,
  hintAfter = 3000,
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
    const elapsed = now() - started;
    const seconds = Math.floor(elapsed / 1000);
    const spinner = frames[frame++ % frames.length];
    const time = seconds ? ` · ${seconds}s` : "";
    let extra = hint && elapsed >= hintAfter ? ` · ${hint}` : "";
    // A line that wraps can't be erased with one "clear line": leave out the hint, then cut the text.
    const width = (output.columns || 80) - 1;
    if (displayWidth(`${spinner} ${text}${time}${extra}`) > width) extra = "";
    const shown = truncateEnd(text, Math.max(1, width - displayWidth(`${spinner} ${time}`)));
    output.write(`\r\x1b[2K${theme.accent(spinner)} ${theme.muted(`${shown}${time}${extra}`)}`);
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
