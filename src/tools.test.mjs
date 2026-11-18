import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { needsConfirmation, runTool, safeProjectPath } from "./tools.mjs";

describe("needsConfirmation", () => {
  it("requires confirmation for risky tools", () => {
    expect(needsConfirmation("shell")).toBe(true);
    expect(needsConfirmation("write_file")).toBe(true);
    expect(needsConfirmation("write_asset")).toBe(true);
    expect(needsConfirmation("edit_file")).toBe(true);
    expect(needsConfirmation("append_file")).toBe(true);
    expect(needsConfirmation("read_file")).toBe(false);
    expect(needsConfirmation("list_dir")).toBe(false);
    expect(needsConfirmation("grep")).toBe(false);
    expect(needsConfirmation("git")).toBe(false);
  });
});

describe("safeProjectPath", () => {
  it("blocks absolute paths and parent traversal", () => {
    expect(() => safeProjectPath("/tmp/nope.txt")).toThrow("relative");
    expect(() => safeProjectPath("../nope.txt")).toThrow("inside the project");
  });
});

describe("runTool", () => {
  it("writes and reads project files in subfolders", async () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      expect(await runTool("write_file", { path: "nested/hello.txt", content: "hello" })).toBe("ok");
      expect(await runTool("read_file", { path: "nested/hello.txt" })).toBe("hello");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a line range, lists directories, and greps", async () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      await runTool("write_file", { path: "src/a.txt", content: "one\ntwo\nthree\n" });
      await runTool("write_file", { path: "node_modules/skip.txt", content: "two" });

      expect(await runTool("read_file", { path: "src/a.txt", start_line: 2, end_line: 3 })).toBe("two\nthree");
      await expect(runTool("read_file", { path: "src/a.txt", start_line: 50 })).rejects.toThrow("outside the file");

      expect(await runTool("list_dir", {})).toBe("src/");
      expect(await runTool("list_dir", { path: "src" })).toBe("a.txt");
      expect(await runTool("list_dir", { recursive: true })).toBe("src/\nsrc/a.txt");

      expect(await runTool("grep", { pattern: "^t" })).toBe("src/a.txt:2:two\nsrc/a.txt:3:three");
      expect(await runTool("grep", { pattern: "nothing", path: "src" })).toBe("no matches");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edits a unique string and rejects missing or ambiguous matches", async () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      await runTool("write_file", { path: "src/a.txt", content: "cat dog dog" });

      expect(await runTool("edit_file", { path: "src/a.txt", old_string: "cat", new_string: "$& bird" })).toBe("ok");
      expect(await runTool("read_file", { path: "src/a.txt" })).toBe("$& bird dog dog");
      await expect(runTool("edit_file", { path: "src/a.txt", old_string: "dog", new_string: "x" })).rejects.toThrow("2 times");
      await expect(runTool("edit_file", { path: "src/a.txt", old_string: "fish", new_string: "x" })).rejects.toThrow("not found");
      await expect(runTool("edit_file", { path: "a.txt", old_string: "x", new_string: "y" })).rejects.toThrow("Root-level");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to files, creating them if needed", async () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      await runTool("append_file", { path: "logs/out.txt", content: "a" });
      await runTool("append_file", { path: "logs/out.txt", content: "b" });
      expect(await runTool("read_file", { path: "logs/out.txt" })).toBe("ab");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks root-level project writes", async () => {
    for (const path of ["hello.txt", "./hello.txt", "src/../hello.txt"]) {
      await expect(runTool("write_file", { path, content: "hello" })).rejects.toThrow("Root-level writes are blocked");
    }
  });

  it("returns shell output, stderr and exit code instead of throwing", async () => {
    // node -e behaves the same under cmd.exe (Windows) and /bin/sh.
    const result = await runTool("shell", { cmd: `node -e "console.log('out'); console.error('err'); process.exit(3)"` });
    expect(result).toContain("out");
    expect(result).toContain("[stderr]\nerr");
    expect(result).toContain("[exit code 3]");
  });

  it("stops a shell command and the processes it started when cancelled", async () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    const controller = new AbortController();

    try {
      chdir(dir);
      // The shell starts node, which records its pid and then waits forever.
      const cmd = `node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)"`;
      const running = runTool("shell", { cmd }, { signal: controller.signal });

      for (let i = 0; i < 100 && !existsSync("pid.txt"); i++) await new Promise((r) => setTimeout(r, 50));
      const pid = Number(readFileSync("pid.txt", "utf8"));
      controller.abort();

      expect(await running).toContain("[cancelled by user]");
      expect(() => process.kill(pid, 0)).toThrow(); // the grandchild is gone too
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives shell commands an empty stdin", async () => {
    const cmd = `node -e "process.stdin.on('end', () => console.log('eof')).resume()"`;
    expect(await runTool("shell", { cmd })).toBe("eof\n");
  });

  it("does not start a shell command that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runTool("shell", { cmd: "echo hi" }, { signal: controller.signal })).toContain("[cancelled by user]");
  });

  it("truncates long shell output", async () => {
    const result = await runTool("shell", { cmd: `node -e "process.stdout.write('a'.repeat(20000))"` });
    expect(result).toContain("[truncated 10000 chars]");
  });

  it("runs read-only git status, diff and log", async () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

    try {
      chdir(dir);
      git("init", "-q");
      await runTool("write_file", { path: "src/a.txt", content: "one\n" });
      git("add", "src/a.txt");
      git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "first");
      await runTool("write_file", { path: "src/a.txt", content: "one\ntwo\n" });
      await runTool("write_file", { path: "src/b.txt", content: "new\n" });

      expect(await runTool("git", { command: "status" })).toContain("?? src/b.txt");
      expect(await runTool("git", { command: "diff" })).toContain("+two");
      expect(await runTool("git", { command: "diff", path: "src/b.txt" })).toBe("(no output)");
      expect(await runTool("git", { command: "diff", staged: true })).toBe("(no output)");
      expect(await runTool("git", { command: "log" })).toContain("first");
      expect(await runTool("git", { command: "log", count: 1 })).toMatch(/^[0-9a-f]+ first\n$/);

      await expect(runTool("git", { command: "push" })).rejects.toThrow("must be one of");
      await expect(runTool("git", { command: "status", path: "../outside" })).rejects.toThrow("inside the project");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores assets under .agent/assets", async () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));

    try {
      chdir(dir);
      expect(await runTool("write_asset", { path: "notes/output.txt", content: "asset" })).toBe(
        "saved to .agent/assets/notes/output.txt",
      );
      expect(existsSync(join(dir, ".agent", "assets", "notes", "output.txt"))).toBe(true);
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
