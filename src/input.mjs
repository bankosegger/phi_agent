import readline from "node:readline/promises";

// Lines entered closer together than this were pasted: nobody types a line in 50ms.
const PASTE_WINDOW_MS = 50;

/**
 * Reads what the user enters, one input at a time.
 *
 * In a terminal, lines that arrive together (a paste) make one input, so a pasted error message
 * is one task, not one per line. A line typed with a "\" at its end goes on in the next one,
 * after `continuationPrompt`. Inputs entered while nothing is asking for one (the agent is
 * working) wait for the next prompt; `onQueued(text)` is told about each.
 * Piped input is read a line at a time, in order: its lines answer confirmation questions too.
 * In a terminal, the up arrow brings back earlier lines: `history` (newest first) and those
 * entered since, which `onHistory(lines)` is told about. Answers to questions, and the lines of
 * an input of several, stay out of it.
 * `completer(line)` completes the line on Tab, as readline's completer does.
 */
export function createInput({
  input = process.stdin,
  output = process.stdout,
  terminal,
  onQueued,
  history = [],
  onHistory,
  completer,
  continuationPrompt = "… ",
  pasteWindowMs = PASTE_WINDOW_MS,
} = {}) {
  const rl = readline.createInterface({ input, output, terminal, history: [...history], historySize: 500, removeHistoryDuplicates: true, completer });
  rl.on("history", (lines) => onHistory?.(lines));
  const closed = new AbortController();
  const queued = [];
  let paste = null; // { lines, timer } while pasted lines are arriving
  let waiting = null; // resolves the pending next()
  let shownPrompt = ""; // the prompt of the pending next()
  let draft = []; // the lines so far of an input that goes on, without their "\"

  // History holds single lines: the lines of an input of several, one by one, would only clutter
  // it. (Readline leaves out blank lines.)
  const forget = (lines) => {
    const count = lines.filter((line) => line.trim()).length;
    if (!count) return;
    rl.history.splice(0, count);
    onHistory?.(rl.history);
  };

  // A terminal shows what the user types. Showing piped input too makes the output read the same.
  const echo = (text) => {
    if (!rl.terminal) output.write(`${text}\n`);
  };

  const deliver = (text) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      if (text != null) echo(text);
      resolve(text);
    } else {
      queued.push(text);
      if (rl.terminal) onQueued?.(text);
    }
  };

  const endPaste = () => {
    // A paste that doesn't end with a line break leaves its last line in the edit buffer.
    // Entering it (this emits "line", which adds it to the paste) keeps the paste whole.
    if (rl.line && !closed.signal.aborted) rl.write("\n");

    const { lines, timer } = paste;
    clearTimeout(timer);
    paste = null;

    // A line typed (not pasted) with a "\" at its end goes on in the next line.
    if (lines.length === 1 && lines[0].endsWith("\\") && !closed.signal.aborted) {
      draft.push(lines[0].slice(0, -1));
      forget(lines);
      if (waiting) {
        rl.setPrompt(continuationPrompt);
        rl.prompt();
      }
      return;
    }
    const all = [...draft, ...lines];
    draft = [];
    if (all.length > 1) forget(lines);
    deliver(all.join("\n"));
  };

  rl.on("line", (line) => {
    if (!rl.terminal) return deliver(line);
    paste ??= { lines: [] };
    paste.lines.push(line);
    clearTimeout(paste.timer);
    paste.timer = setTimeout(endPaste, pasteWindowMs);
  });

  rl.on("close", () => {
    closed.abort();
    if (paste) endPaste();
    if (waiting) deliver(null);
  });

  return {
    // The next input, or null once input has ended. Shows `prompt` while it waits.
    next(prompt) {
      if (queued.length) {
        const text = queued.shift();
        output.write(`${prompt}${text}\n`); // what runs now, entered earlier
        return Promise.resolve(text);
      }
      if (closed.signal.aborted) return Promise.resolve(null);

      // An input started while the agent worked goes on after the prompt.
      shownPrompt = prompt;
      rl.setPrompt(draft.length ? continuationPrompt : prompt);
      rl.prompt(true);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },

    // A one-line answer to `query`, or null if `signal` aborts or input ends.
    async ask(query, signal) {
      if (!rl.terminal && queued.length) {
        const answer = queued.shift();
        output.write(`${query}${answer}\n`);
        return answer;
      }

      const signals = signal ? [closed.signal, signal] : [closed.signal];
      try {
        const answer = await rl.question(query, { signal: AbortSignal.any(signals) });
        echo(answer);
        // A "y" isn't worth bringing back with the up arrow.
        if (rl.terminal && answer && rl.history[0] === answer) {
          rl.history.shift();
          onHistory?.(rl.history);
        }
        return answer;
      } catch (error) {
        if (error.name !== "AbortError") throw error;
        output.write("\n");
        return null;
      }
    },

    // Forgets inputs entered ahead. Returns how many there were.
    clearQueue() {
      return queued.splice(0).length;
    },

    // Throws away what the user is typing at the prompt: the line, and the lines before it of an
    // input that goes on. Returns whether there was anything.
    discardDraft() {
      if (!rl.terminal || (!draft.length && !rl.line)) return false;
      draft = [];
      if (rl.line) {
        rl.write(null, { ctrl: true, name: "e" }); // to the end of the line,
        rl.write(null, { ctrl: true, name: "u" }); // and delete it all
      }
      if (waiting) {
        output.write("\r\x1b[K");
        rl.setPrompt(shownPrompt);
        rl.prompt();
      }
      return true;
    },

    // handler() runs on Ctrl+C in a terminal.
    onInterrupt(handler) {
      rl.on("SIGINT", handler);
    },

    // Whether the user has typed part of a line in the terminal and not entered it yet.
    get typing() {
      return Boolean(rl.terminal && rl.line);
    },

    // handler() runs on each key pressed in the terminal, before the key is shown, so output
    // like a progress line can make way for what the user types.
    beforeKeypress(handler) {
      if (rl.terminal) input.prependListener("keypress", handler);
    },

    close() {
      rl.close();
    },
  };
}
