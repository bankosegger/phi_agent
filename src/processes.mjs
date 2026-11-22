import { spawn, spawnSync } from "node:child_process";

// The commands the model runs, and the ones it leaves running in the background, like a dev
// server: those run until the model or the user stops them, or until the agent quits or starts
// a new conversation.

const MAX_RUNNING = 5;
const MAX_KEPT_OUTPUT = 1024 * 1024; // characters of each background process's latest output
const POLL_MS = 100;
// New output counts as complete once nothing more has come for this long.
const SETTLE_MS = 500;
const STOP_WAIT_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The agent's API keys, which commands don't need and which would otherwise end up in the
// conversation if one printed them.
const API_KEYS = new Set(["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]);

// The environment for the model's commands: the agent's, without its API keys.
export function commandEnv(env = process.env) {
  const result = { ...env };
  for (const name of Object.keys(result)) {
    if (API_KEYS.has(name.toUpperCase())) delete result[name];
  }
  return result;
}

// Starts `cmd` with the system shell in the project folder. stdin is closed so commands that wait
// for input fail fast instead of hanging. On POSIX the command gets its own process group so the
// whole group can be killed. (On Windows, detached would open a new console window; taskkill /T
// covers the tree.)
export function spawnShell(cmd) {
  return spawn(cmd, {
    shell: true,
    env: commandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

// Kills the command and anything it started; the shell alone may leave children running.
export function killProcessTree(child) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // Already exited.
  }
}

class BackgroundProcess {
  output = ""; // the latest output, stdout and stderr as they came
  dropped = 0; // characters dropped from the start of `output` to keep it small
  seen = 0; // characters the model has been given, dropped ones included
  lastOutputAt = 0;
  exit = null; // once it has ended: { code, signal } or { error }
  stopped = false;

  constructor(id, cmd, maxKeptOutput) {
    this.id = id;
    this.cmd = cmd;
    this.startedAt = Date.now();
    this.maxKeptOutput = maxKeptOutput;
    this.child = spawnShell(cmd);
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream.setEncoding("utf8").on("data", (text) => this.#append(text));
    }
    this.child.on("error", (error) => (this.exit ??= { error }));
    this.child.on("close", (code, signal) => (this.exit ??= { code, signal }));
  }

  get running() {
    return this.exit === null;
  }

  // Characters of output the model hasn't been given yet.
  get unread() {
    return this.dropped + this.output.length - this.seen;
  }

  #append(text) {
    this.output += text;
    this.lastOutputAt = Date.now();
    const excess = this.output.length - this.maxKeptOutput;
    if (excess > 0) {
      this.output = this.output.slice(excess);
      this.dropped += excess;
    }
  }

  /** The output not read yet, and how many characters of it were dropped before it could be. */
  read() {
    const lost = Math.max(0, this.dropped - this.seen);
    const text = this.output.slice(Math.max(0, this.seen - this.dropped));
    this.seen = this.dropped + this.output.length;
    return { text, lost };
  }

  /** The last line of output, for a list of the processes. */
  get lastLine() {
    return (
      this.output
        .split(/\r?\n|\r/)
        .map((line) => line.trim())
        .findLast(Boolean) ?? ""
    );
  }

  // Stops the process and what it started, and waits a little for its last output.
  async stop() {
    if (!this.running) return;
    this.stopped = true;
    killProcessTree(this.child);
    for (let waited = 0; this.running && waited < STOP_WAIT_MS; waited += POLL_MS) await sleep(POLL_MS);
    if (this.running) {
      // A process that escaped the kill can hold the output pipes open; stop waiting for it.
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.exit = { signal: "SIGKILL" };
    }
  }
}

/** The background processes of a session, numbered from 1. */
export class BackgroundProcesses {
  #processes = new Map();
  #nextId = 1;
  #maxRunning;
  #maxKeptOutput;

  constructor({ maxRunning = MAX_RUNNING, maxKeptOutput = MAX_KEPT_OUTPUT } = {}) {
    this.#maxRunning = maxRunning;
    this.#maxKeptOutput = maxKeptOutput;
  }

  /** Every process started since the last stopAll, oldest first. */
  get list() {
    return [...this.#processes.values()];
  }

  get running() {
    return this.list.filter((proc) => proc.running);
  }

  /** Throws if as many processes as allowed are running already. */
  checkRoom() {
    if (this.running.length >= this.#maxRunning) {
      throw new Error(`Can't run more than ${this.#maxRunning} background processes at once; stop one with stop_process first`);
    }
  }

  start(cmd) {
    this.checkRoom();
    const proc = new BackgroundProcess(this.#nextId++, cmd, this.#maxKeptOutput);
    this.#processes.set(proc.id, proc);
    return proc;
  }

  get(id) {
    const proc = this.#processes.get(Number(id));
    if (proc) return proc;
    const ids = this.list.map((p) => p.id).join(", ");
    throw new Error(`There is no background process ${id}. ${ids ? `There are: ${ids}.` : "None have been started."}`);
  }

  /**
   * Waits up to `seconds` until the process has printed something new and then gone quiet for a
   * moment, or has ended. Returns early when `signal` aborts.
   */
  async waitForOutput(proc, seconds, signal) {
    const deadline = Date.now() + seconds * 1000;
    while (proc.running && Date.now() < deadline && !signal?.aborted) {
      if (proc.unread > 0 && Date.now() - proc.lastOutputAt >= SETTLE_MS) return;
      await sleep(POLL_MS);
    }
  }

  /** Stops every running process and forgets them all. Returns how many were running. */
  async stopAll() {
    const running = this.running;
    await Promise.all(running.map((proc) => proc.stop()));
    this.#processes.clear();
    return running.length;
  }

  /** Kills every running process at once, for when the agent is exiting and can't wait. */
  killAll() {
    for (const proc of this.running) killProcessTree(proc.child);
  }
}

/** The background processes the model starts with the shell tool. */
export const backgroundProcesses = new BackgroundProcesses();
