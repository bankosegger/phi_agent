import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { commandStatus, fitLine, gitState, statusText } from "./statusline.mjs";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const git = (dir, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });

describe("statusText", () => {
  it("names the model, the branch, and the modes that change what the agent does", () => {
    expect(statusText({ model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(statusText({ model: "m", git: { branch: "main", dirty: false } })).toBe("m · main");
    expect(statusText({ model: "m", git: { branch: "fix/parser", dirty: true }, plan: true, sandbox: true, yes: true })).toBe("m · fix/parser* · plan mode · sandbox · approves everything");
  });
});

describe("fitLine", () => {
  it("keeps a line that fits, and cuts one that doesn't, with …", () => {
    expect(fitLine("short", 10)).toBe("short");
    expect(fitLine("a longer line", 8)).toBe("a longe…");
  });

  it("counts colors for nothing, never cuts one in half, and resets them after a cut", () => {
    const line = "\x1b[32mgreen\x1b[0m and \x1b[1mbold text\x1b[22m";
    expect(fitLine(line, 30)).toBe(line);
    const cut = fitLine(line, 12);
    expect(plain(cut)).toBe("green and b…");
    expect(cut).toBe("\x1b[32mgreen\x1b[0m and \x1b[1mb…\x1b[0m");
  });
});

describe("gitState", () => {
  it("names the branch, and whether tracked files have changes that aren't committed", async () => {
    const { dir, cleanup } = tempDir();
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "a.txt"), "one\n");
      git(dir, "add", "a.txt");
      git(dir, "commit", "-q", "-m", "first");
      expect(await gitState(dir)).toEqual({ branch: "main", dirty: false });

      // A new file git doesn't track yet doesn't count; a change to a tracked one does.
      writeFileSync(join(dir, "new.txt"), "x\n");
      expect(await gitState(dir)).toEqual({ branch: "main", dirty: false });
      writeFileSync(join(dir, "a.txt"), "two\n");
      expect(await gitState(dir)).toEqual({ branch: "main", dirty: true });

      // Without a branch, the commit.
      git(dir, "commit", "-q", "-am", "second");
      git(dir, "checkout", "-q", "--detach");
      const commit = git(dir, "rev-parse", "--short=7", "HEAD").stdout.trim();
      expect(await gitState(dir)).toEqual({ branch: commit, dirty: false });
    } finally {
      cleanup();
    }
  });

  it("is null outside a repository", async () => {
    const { dir, cleanup } = tempDir();
    try {
      expect(await gitState(dir)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("commandStatus", () => {
  // A status line command in a file, run with node.
  function command(dir, source) {
    const file = join(dir, "status.js");
    writeFileSync(file, source);
    return `node "${file}"`;
  }

  it("gives the command what the agent knows, and shows the first line it prints", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const status = command(
        dir,
        `let input = ""; process.stdin.on("data", (c) => (input += c)).on("end", () => { const info = JSON.parse(input); console.log(""); console.log(\`\\x1b[36m\${info.model}\\x1b[0m · \${info.context.percent}%\`); console.log("second line"); });`,
      );
      expect(await commandStatus(status, { model: "claude-opus-5-5", context: { percent: 12 } }, { cwd: dir })).toBe("\x1b[36mclaude-opus-5-5\x1b[0m · 12%");
    } finally {
      cleanup();
    }
  });

  it("leaves out what could move the cursor, keeping the colors", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const status = command(dir, `process.stdout.write("\\x1b[2J\\x1b[31mred\\x1b[0m\\tand \\x1b]8;;https://x.org\\x07link\\x1b]8;;\\x07\\x07\\x1b[1A done\\n");`);
      expect(await commandStatus(status, {}, { cwd: dir })).toBe("\x1b[31mred\x1b[0m and link done");
    } finally {
      cleanup();
    }
  });

  it("shows nothing for a command that fails, prints nothing, or takes too long", async () => {
    const { dir, cleanup } = tempDir();
    try {
      expect(await commandStatus(command(dir, "console.log('oops'); process.exit(1);"), {}, { cwd: dir })).toBeNull();
      expect(await commandStatus(command(dir, "console.log('   ');"), {}, { cwd: dir })).toBeNull();
      expect(await commandStatus(command(dir, "setTimeout(() => console.log('late'), 5000);"), {}, { cwd: dir, timeoutMs: 300 })).toBeNull();
      expect(await commandStatus("no-such-command-anywhere", {}, { cwd: dir })).toBeNull();
    } finally {
      cleanup();
    }
  });
});
