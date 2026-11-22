import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chdir, cwd } from "node:process";
import { commandEnv } from "./processes.mjs";
import { checkToolCall, globToRegExp, isSecretFile, needsConfirmation, runTool, safeProjectPath, shellTimeout, toolsFor } from "./tools.mjs";

// Whether process `pid` has ended, waiting up to 3 seconds for it. A killed process whose parent
// was killed too is a zombie until the system reaps it, which kill(pid, 0) still finds; on
// Linux, /proc says when a process is one.
async function ended(pid) {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (process.platform === "linux") {
      try {
        if (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).startsWith("Z")) return true;
      } catch {
        return true; // gone meanwhile
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function inTempDir(fn) {
  const originalCwd = cwd();
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  try {
    chdir(dir);
    return await fn(dir);
  } finally {
    chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

// A git project with built files, logs and dependencies that searches should leave out.
const PROJECT = {
  ".gitignore": "dist/\n*.log\n",
  "README.md": "# Demo\n",
  "debug.log": "export log\n",
  "dist/out.js": "export const built = 1;\n",
  "logs/app.log": "export failed\n",
  "node_modules/dep/index.js": "export const dep = 1;\n",
  "src/a.js": "export const a = 1;\n",
  "src/b.test.js": "import { a } from './a.js';\n",
  "src/lib/c.js": "export const c = 3;\n",
};

async function inGitProject(fn) {
  await inTempDir(async (dir) => {
    git("init", "-q");
    writeFiles(PROJECT);
    await fn(dir);
  });
}

describe("needsConfirmation", () => {
  it("requires confirmation for risky tools", () => {
    expect(needsConfirmation("shell")).toBe(true);
    expect(needsConfirmation("write_file")).toBe(true);
    expect(needsConfirmation("write_asset")).toBe(true);
    expect(needsConfirmation("edit_file")).toBe(true);
    expect(needsConfirmation("append_file")).toBe(true);
    expect(needsConfirmation("delete_file")).toBe(true);
    expect(needsConfirmation("move_file")).toBe(true);
    expect(needsConfirmation("fetch_url")).toBe(true);
    expect(needsConfirmation("read_file")).toBe(false);
    expect(needsConfirmation("list_dir")).toBe(false);
    expect(needsConfirmation("grep")).toBe(false);
    expect(needsConfirmation("git")).toBe(false);
  });

  it("requires it for reading or searching a file that may hold secrets", () => {
    expect(needsConfirmation("read_file", { path: ".env" })).toBe(true);
    expect(needsConfirmation("read_file", { path: "config\\keys\\server.pem" })).toBe(true);
    expect(needsConfirmation("grep", { path: "deploy/.env.production", pattern: "KEY" })).toBe(true);
    expect(needsConfirmation("read_file", { path: ".env.example" })).toBe(false);
    expect(needsConfirmation("read_file", { path: "src/env.js" })).toBe(false);
    expect(needsConfirmation("grep", { path: ".", pattern: "KEY" })).toBe(false);
  });
});

describe("isSecretFile", () => {
  it("knows files that hold secrets by their names, but not their templates", () => {
    const secrets = [".env", ".ENV.local", "prod.env", "id_rsa", "id_ed25519", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials.json", "tls.key", "cert.pem", "store.p12", "app.pfx", "release.jks", "release.keystore"];
    for (const name of secrets) expect(isSecretFile(`a/${name}`), name).toBe(true);
    for (const name of [".env.example", ".env.sample", "secrets.env.template", "id_rsa.pub", "environment.ts", "keys.js", ".envrc.md", "README.md"]) {
      expect(isSecretFile(name), name).toBe(false);
    }
    expect(isSecretFile(undefined)).toBe(false);
  });
});

describe("safeProjectPath", () => {
  it("blocks absolute paths and parent traversal", () => {
    expect(() => safeProjectPath("/tmp/nope.txt")).toThrow("relative");
    expect(() => safeProjectPath("../nope.txt")).toThrow("inside the project");
  });
});

describe("checkToolCall", () => {
  it("throws for calls that would fail, without changing anything", async () => {
    await inTempDir(async () => {
      writeFiles({ "src/a.js": "const a = 1;\n" });

      expect(() => checkToolCall("edit_file", { path: "src/a.js", old_string: "b", new_string: "c" })).toThrow("old_string not found");
      expect(() => checkToolCall("edit_file", { path: "src/x.js", old_string: "b", new_string: "c" })).toThrow("does not exist");
      expect(() => checkToolCall("write_file", { path: "new.js", content: "x" })).toThrow("project root");
      expect(() => checkToolCall("append_file", { path: "../out.txt", content: "x" })).toThrow("inside the project");
      expect(() => checkToolCall("write_asset", { path: "../../x.txt", content: "x" })).toThrow("inside .agent/assets");
      expect(() => checkToolCall("shell", { cmd: " " })).toThrow("cmd must not be empty");
      expect(() => checkToolCall("delete_file", { path: "src/x.js" })).toThrow("does not exist");
      expect(() => checkToolCall("move_file", { from: "src/a.js", to: "a.js" })).toThrow("project root");
      expect(() => checkToolCall("fetch_url", { url: "file:///etc/passwd" })).toThrow("only fetches http and https");

      checkToolCall("edit_file", { path: "src/a.js", old_string: "a = 1", new_string: "a = 2" });
      checkToolCall("write_file", { path: "src/new/b.js", content: "x" });
      checkToolCall("delete_file", { path: "src/a.js" });
      checkToolCall("move_file", { from: "src/a.js", to: "src/new/a.js" });
      checkToolCall("shell", { cmd: "node -e \"require('fs').writeFileSync('ran.txt', '')\"" });
      checkToolCall("read_file", {});

      expect(readFileSync("src/a.js", "utf8")).toBe("const a = 1;\n");
      expect(existsSync("src/new")).toBe(false);
      expect(existsSync("ran.txt")).toBe(false);
    });
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
      await expect(runTool("edit_file", { path: "src/a.txt", old_string: "dog", new_string: "x" })).rejects.toThrow(
        "old_string appears 2 times, on line 1; add more context to make it unique",
      );
      await expect(runTool("edit_file", { path: "src/a.txt", old_string: "fish", new_string: "x" })).rejects.toThrow("not found");
      await expect(runTool("edit_file", { path: "src/b.txt", old_string: "x", new_string: "y" })).rejects.toThrow(
        "src/b.txt does not exist; create it with write_file",
      );
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows the model the text closest to an old_string that isn't in the file", async () => {
    await inTempDir(async () => {
      const code = ["function add(a, b) {", "\treturn a - b;", "}", "", "function sub(a, b) {", "\treturn a - b;", "}", "", "export { add, sub };"].join("\n");
      writeFileSync("math.js", code);
      const miss = (old_string) => runTool("edit_file", { path: "math.js", old_string, new_string: "x" }).then(() => "edited", (error) => error.message);

      const copy = "Copy that text exactly into old_string.";
      const check = "If that is what you meant to change, copy it exactly into old_string.";
      // The usual slip: spaces where the file has a tab. The lines go back exactly as they are.
      expect(await miss("function add(a, b) {\n  return a - b;\n}")).toBe(
        ["old_string not found, but lines 1-3 match it apart from spaces and tabs:", "function add(a, b) {", "\treturn a - b;", "}", copy].join("\n"),
      );
      // Within a line, too, and from partway through one line to partway through another.
      expect(await miss("export {add, sub}")).toBe(`old_string not found, but line 9 matches it apart from spaces and tabs:\nexport { add, sub };\n${copy}`);
      expect(await miss("add(a,b) {\n  return a - b")).toBe(
        ["old_string not found, but lines 1-2 match it apart from spaces and tabs:", "function add(a, b) {", "\treturn a - b;", copy].join("\n"),
      );
      // One line wrong: the others say where it is, even when the wrong one is the longest.
      expect(await miss("function sub(a, b) {\n\treturn a + b;\n}")).toBe(
        ["old_string not found. The closest text, at lines 5-7, reads:", "function sub(a, b) {", "\treturn a - b;", "}", check].join("\n"),
      );
      expect(await miss("function sub(a, b) {\n\treturn a + b + c + d + e + f;\n}")).toMatch(/^old_string not found\. The closest text, at lines 5-7, reads:/);
      // Blank lines around old_string don't count.
      expect(await miss("\nfunction add(a, b) {\n  return a - b;\n}\n")).toMatch(/^old_string not found, but lines 1-3 match it apart from spaces and tabs:/);
      // A line that is nearly the same.
      expect(await miss("expotr { add, sub }")).toBe(`old_string not found. The closest text, at line 9, reads:\nexport { add, sub };\n${check}`);
      expect(await miss("class Calculator {}")).toBe("old_string not found, and nothing in the file is much like it.\nRead the file to see what it has now.");
      expect(await miss("\treturn a - b;")).toBe("old_string appears 2 times, on lines 2 and 6; add more context to make it unique");
    });
  });

  it("asks before searching a file that may hold secrets, and otherwise leaves them out of searches", async () => {
    await inTempDir(async () => {
      mkdirSync("src");
      writeFileSync("src/app.js", "const key = process.env.API_KEY;\n");
      writeFileSync(".env", "API_KEY=sk-secret\n");
      writeFileSync(".env.example", "API_KEY=\n");

      expect(await runTool("grep", { pattern: "API_KEY" })).toBe(
        ".env.example:1:API_KEY=\nsrc/app.js:1:const key = process.env.API_KEY;\n[files that may hold secrets were not searched: .env]",
      );
      expect(await runTool("grep", { pattern: "sk-" })).toBe("no matches (files that may hold secrets were not searched: .env)");
      // Named as the path, which asks the user first, it is searched.
      expect(await runTool("grep", { pattern: "sk-", path: ".env" })).toBe(".env:1:API_KEY=sk-secret");
    });
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

  it("blocks new files at the project root, but changes existing ones", async () => {
    await inTempDir(async () => {
      for (const path of ["hello.txt", "./hello.txt", "src/../hello.txt"]) {
        await expect(runTool("write_file", { path, content: "hello" })).rejects.toThrow("New files can't be created at the project root");
        await expect(runTool("append_file", { path, content: "hello" })).rejects.toThrow("New files can't be created at the project root");
      }
      expect(existsSync("hello.txt")).toBe(false);

      writeFiles({ "package.json": '{ "name": "demo" }\n', ".gitignore": "dist/\n" });
      await runTool("edit_file", { path: "package.json", old_string: "demo", new_string: "app" });
      await runTool("append_file", { path: ".gitignore", content: "*.log\n" });
      await runTool("write_file", { path: "./package.json", content: "{}\n" });
      expect(readFileSync("package.json", "utf8")).toBe("{}\n");
      expect(readFileSync(".gitignore", "utf8")).toBe("dist/\n*.log\n");
    });
  });

  it("blocks changes inside .git", async () => {
    await inTempDir(async () => {
      writeFiles({ ".git/config": "[core]\n", "sub/.GIT/HEAD": "ref\n" });
      await expect(runTool("write_file", { path: ".git/hooks/pre-commit", content: "evil" })).rejects.toThrow("inside .git");
      await expect(runTool("append_file", { path: ".git/config", content: "x" })).rejects.toThrow("inside .git");
      await expect(runTool("edit_file", { path: "sub/.GIT/HEAD", old_string: "ref", new_string: "x" })).rejects.toThrow("inside .git");
      expect(existsSync(".git/hooks")).toBe(false);
      expect(readFileSync(".git/config", "utf8")).toBe("[core]\n");
    });
  });

  it("keeps the API keys out of commands' environment", async () => {
    expect(commandEnv({ OPENROUTER_API_KEY: "a", openrouter_api_key: "b", ANTHROPIC_API_KEY: "c", PATH: "/bin" })).toEqual({ PATH: "/bin" });

    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-secret";
    try {
      const result = await runTool("shell", { cmd: `node -e "console.log(process.env.OPENROUTER_API_KEY || 'no key')"` });
      expect(result).toContain("no key");
      expect(result).not.toContain("sk-secret");
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
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
      expect(await ended(pid)).toBe(true); // the grandchild is gone too
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

  it("keeps the start and end of long shell output, and how the command ended", async () => {
    const result = await runTool("shell", { cmd: `node -e "process.stdout.write('a'.repeat(20000) + 'END'); process.exit(2)"` });
    expect(result).toMatch(/^a{3000}\n\[… 10003 chars omitted …\]\na{6997}END\n\[exit code 2\]$/);
  });

  it("stops a shell command after its timeout", async () => {
    expect(await runTool("shell", { cmd: `node -e "setTimeout(() => {}, 30000)"`, timeout: 1 })).toBe("[timed out after 1s]");
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

  it("greps regardless of case when asked, and reads an empty path as the project root", async () => {
    await inTempDir(async () => {
      await runTool("write_file", { path: "src/a.txt", content: "Hello\n" });

      expect(await runTool("grep", { pattern: "hello" })).toBe("no matches");
      expect(await runTool("grep", { pattern: "hello", ignore_case: true })).toBe("src/a.txt:1:Hello");
      expect(await runTool("grep", { pattern: "Hello", path: "" })).toBe("src/a.txt:1:Hello");
      expect(await runTool("list_dir", { path: "" })).toBe("src/");
    });
  });

  it("rejects missing arguments before doing anything", async () => {
    await inTempDir(async () => {
      await expect(runTool("shell", {})).rejects.toThrow("cmd must be a string");
      await expect(runTool("shell", { cmd: " " })).rejects.toThrow("cmd must not be empty");
      await expect(runTool("grep", {})).rejects.toThrow("pattern must be a string");
      await expect(runTool("write_file", { path: "src/x.txt" })).rejects.toThrow("content must be a string");
      await expect(runTool("edit_file", { path: "src/x.txt", old_string: "a" })).rejects.toThrow("new_string must be a string");
      expect(existsSync("src")).toBe(false);
    });
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
      expect(readFileSync(join(dir, ".agent", ".gitignore"), "utf8")).toBe("*\n");
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("view_image", () => {
  it("returns an image as a message part, and refuses other files", async () => {
    await inTempDir(async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      writeFiles({ "docs/ui.png": png, "docs/notes.txt": "text" });

      expect(await runTool("view_image", { path: "docs/ui.png" })).toEqual({
        content: "docs/ui.png follows as an image.",
        parts: [
          { type: "text", text: "docs/ui.png:" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
        ],
      });
      await expect(runTool("view_image", { path: "docs/notes.txt" })).rejects.toThrow("isn't a PNG, JPEG, GIF or WebP image");
      await expect(runTool("view_image", { path: "../outside.png" })).rejects.toThrow("inside the project");
      // read_file says where to look instead.
      await expect(runTool("read_file", { path: "docs/ui.png" })).rejects.toThrow("look at images with view_image");
    });
  });

  it("is left out for models that can't see images", () => {
    const names = (list) => list.map((tool) => tool.function.name);
    expect(names(toolsFor())).toContain("view_image");
    expect(names(toolsFor({ images: false }))).not.toContain("view_image");
    expect(toolsFor({ images: false })).toHaveLength(toolsFor().length - 1);
  });
});

describe("delete_file and move_file", () => {
  it("deletes a file or a folder, and the folders that leaves empty", async () => {
    await inTempDir(async () => {
      writeFiles({ "src/a.js": "a\n", "src/old/b.js": "b\n", "src/old/deep/c.js": "c\n", "lib/only/d.js": "d\n", "package.json": "{}\n" });

      expect(await runTool("delete_file", { path: "src/old" })).toBe("deleted src/old (a folder with 2 files)");
      expect(existsSync("src/old")).toBe(false);
      expect(existsSync("src/a.js")).toBe(true);

      expect(await runTool("delete_file", { path: "lib/only/d.js" })).toBe("deleted lib/only/d.js");
      expect(existsSync("lib")).toBe(false);

      // Existing files at the project root can go too.
      await runTool("delete_file", { path: "package.json" });
      expect(existsSync("package.json")).toBe(false);
    });
  });

  it("never removes the project folder, even when that leaves it empty", async () => {
    await inTempDir(async (dir) => {
      writeFiles({ "src/a.js": "a\n" });
      await runTool("delete_file", { path: "src/a.js" });
      expect(existsSync("src")).toBe(false);
      // (Windows can't remove the current folder anyway; elsewhere this is the guard's job.)
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("moves and renames files and folders, making and removing folders as needed", async () => {
    await inTempDir(async () => {
      writeFiles({ "src/main.js": "main\n", "src/old/only.js": "x\n", "src/utils/a.js": "a\n", "src/utils/deep/b.js": "b\n" });

      expect(await runTool("move_file", { from: "src/main.js", to: "src/index.js" })).toBe("moved src/main.js to src/index.js");
      expect(readFileSync("src/index.js", "utf8")).toBe("main\n");
      expect(existsSync("src/main.js")).toBe(false);

      await runTool("move_file", { from: "src/old/only.js", to: "lib/new/only.js" });
      expect(readFileSync("lib/new/only.js", "utf8")).toBe("x\n");
      expect(existsSync("src/old")).toBe(false);

      // A folder moves with everything in it, and may go to the project root.
      await runTool("move_file", { from: "src/utils", to: "utils" });
      expect(readFileSync("utils/deep/b.js", "utf8")).toBe("b\n");
      expect(existsSync("src/utils")).toBe(false);
      expect(existsSync("src/index.js")).toBe(true);
    });
  });

  it("refuses to delete or move what it shouldn't", async () => {
    await inTempDir(async () => {
      writeFiles({ "src/a.js": "a\n", "src/b.js": "b\n", "lib/c.js": "c\n", ".git/config": "[core]\n", "vendor/repo/.git/HEAD": "ref\n" });

      await expect(runTool("delete_file", { path: "src/missing.js" })).rejects.toThrow("src/missing.js does not exist");
      await expect(runTool("delete_file", { path: "." })).rejects.toThrow("project folder itself");
      await expect(runTool("delete_file", { path: "../x" })).rejects.toThrow("inside the project");
      await expect(runTool("delete_file", { path: ".git/config" })).rejects.toThrow("inside .git");
      await expect(runTool("delete_file", { path: "vendor" })).rejects.toThrow("vendor contains a .git folder");

      await expect(runTool("move_file", { from: "src/missing.js", to: "src/x.js" })).rejects.toThrow("does not exist");
      await expect(runTool("move_file", { from: "src/a.js", to: "src/b.js" })).rejects.toThrow("src/b.js already exists");
      await expect(runTool("move_file", { from: "src/a.js", to: "lib/" })).rejects.toThrow("include the name: lib/a.js");
      await expect(runTool("move_file", { from: "src", to: "src/inner/src" })).rejects.toThrow("can't be moved into itself");
      await expect(runTool("move_file", { from: "src/a.js", to: "a.js" })).rejects.toThrow("project root");
      await expect(runTool("move_file", { from: "src/a.js", to: ".git/a.js" })).rejects.toThrow("inside .git");
      await expect(runTool("move_file", { from: ".", to: "src/x" })).rejects.toThrow("project folder itself");
      await expect(runTool("move_file", { from: "vendor", to: "lib/vendor" })).rejects.toThrow("contains a .git folder");

      expect(readFileSync("src/a.js", "utf8")).toBe("a\n");
      expect(readFileSync("src/b.js", "utf8")).toBe("b\n");
      expect(readFileSync(".git/config", "utf8")).toBe("[core]\n");
      expect(existsSync("vendor/repo/.git/HEAD")).toBe(true);
      expect(existsSync("src/inner")).toBe(false);
    });
  });

  it("renames a file whose name only changes case where names don't ignore case", async () => {
    await inTempDir(async () => {
      writeFiles({ "src/readme.md": "hi\n" });
      if (existsSync("src/README.md")) {
        // Windows and macOS: both names are the same file.
        await expect(runTool("move_file", { from: "src/readme.md", to: "src/README.md" })).rejects.toThrow("are the same file");
      } else {
        await runTool("move_file", { from: "src/readme.md", to: "src/README.md" });
        expect(readFileSync("src/README.md", "utf8")).toBe("hi\n");
      }
    });
  });

  it("refuses links, and folders too big to keep for undo", async () => {
    await inTempDir(async () => {
      writeFiles({ "lib/a.js": "a\n" });
      for (let i = 0; i <= 1000; i++) writeFiles({ [`big/${i}.txt`]: "" });
      await expect(runTool("delete_file", { path: "big" })).rejects.toThrow("big has more than 1000 files or 50 MB");
      await expect(runTool("move_file", { from: "big", to: "lib/big" })).rejects.toThrow("use shell to move it");
      expect(existsSync("big/1000.txt")).toBe(true);

      // A junction (a folder link that Windows allows without admin rights) or a symlink.
      mkdirSync("src");
      symlinkSync(resolve("lib"), "src/linked", "junction");
      await expect(runTool("delete_file", { path: "src/linked" })).rejects.toThrow("src/linked is a link");
      await expect(runTool("delete_file", { path: "src" })).rejects.toThrow("src/linked is a link");
      expect(readFileSync("lib/a.js", "utf8")).toBe("a\n");
    });
  });
});

describe("searching a git project", () => {
  it("lists what git doesn't ignore, and names what it does", async () => {
    await inGitProject(async () => {
      const ignored = "[ignored by git, not listed: debug.log, dist/, logs/]";
      expect(await runTool("list_dir", {})).toBe(`.gitignore\nREADME.md\nsrc/\n${ignored}`);
      expect(await runTool("list_dir", { recursive: true })).toBe(
        `.gitignore\nREADME.md\nsrc/\nsrc/a.js\nsrc/b.test.js\nsrc/lib/\nsrc/lib/c.js\n${ignored}`,
      );
      expect(await runTool("list_dir", { path: "src/lib" })).toBe("c.js");
      // A folder git ignores is listed when asked for by name, whether git ignores it by its
      // name (dist/) or for its contents (logs/ holds only *.log files).
      expect(await runTool("list_dir", { path: "dist" })).toBe("out.js");
      expect(await runTool("list_dir", { path: "logs" })).toBe("app.log");
    });
  });

  it("finds files by glob pattern", async () => {
    await inGitProject(async () => {
      const find = (args) => runTool("find_files", args);

      expect(await find({ pattern: "*.js" })).toBe("src/a.js\nsrc/b.test.js\nsrc/lib/c.js");
      expect(await find({ pattern: "src/*.js" })).toBe("src/a.js\nsrc/b.test.js");
      expect(await find({ pattern: "/src/*.js" })).toBe("src/a.js\nsrc/b.test.js");
      expect(await find({ pattern: "**/*.TEST.js" })).toBe("src/b.test.js");
      expect(await find({ pattern: "{readme,license}.md" })).toBe("README.md");
      // With a path, the pattern can be relative to it or to the project.
      expect(await find({ pattern: "lib/*.js", path: "src" })).toBe("src/lib/c.js");
      expect(await find({ pattern: "src/lib/*", path: "src" })).toBe("src/lib/c.js");

      expect(await find({ pattern: "*.js", path: "dist" })).toBe("dist/out.js");
      expect(await find({ pattern: "*.log" })).toBe("no files found (files git ignores were not searched)");
      await expect(find({ pattern: "*", path: "README.md" })).rejects.toThrow("not a folder");
      await expect(find({ pattern: " " })).rejects.toThrow("must not be empty");
    });
  });

  it("greps files git doesn't ignore, optionally only those matching a glob", async () => {
    await inGitProject(async () => {
      expect(await runTool("grep", { pattern: "^export" })).toBe("src/a.js:1:export const a = 1;\nsrc/lib/c.js:1:export const c = 3;");
      expect(await runTool("grep", { pattern: "a", glob: "*.test.js" })).toBe("src/b.test.js:1:import { a } from './a.js';");
      expect(await runTool("grep", { pattern: "built" })).toBe("no matches (files git ignores were not searched)");
      expect(await runTool("grep", { pattern: "built", path: "dist" })).toBe("dist/out.js:1:export const built = 1;");
      expect(await runTool("grep", { pattern: "failed", path: "logs" })).toBe("logs/app.log:1:export failed");
    });
  });

  it("ignores nothing when git ignores the whole project", async () => {
    // Like a project inside a home folder kept in git with "*" in its .gitignore.
    await inTempDir(async () => {
      git("init", "-q");
      writeFiles({ ".gitignore": "*\n", "project/src/a.js": "x\n" });
      chdir("project");
      expect(await runTool("list_dir", { recursive: true })).toBe("src/\nsrc/a.js");
    });
  });
});

describe("globToRegExp", () => {
  const matches = (glob, path) => globToRegExp(glob).test(path);

  it("matches * and ? within a name, and ** across folders", () => {
    expect(matches("*.js", "a.js")).toBe(true);
    expect(matches("*.js", "src/a.js")).toBe(false);
    expect(matches("**/*.js", "a.js")).toBe(true);
    expect(matches("**/*.js", "src/lib/a.js")).toBe(true);
    expect(matches("src/**", "src/lib/a.js")).toBe(true);
    expect(matches("file?.txt", "file1.txt")).toBe(true);
    expect(matches("file?.txt", "file12.txt")).toBe(false);
  });

  it("supports alternatives and character sets, ignores case, and treats other characters literally", () => {
    expect(matches("{README,CHANGELOG}.md", "readme.md")).toBe(true);
    expect(matches("{README,CHANGELOG}.md", "LICENSE.md")).toBe(false);
    expect(matches("[ab].js", "b.js")).toBe(true);
    expect(matches("[!ab].js", "b.js")).toBe(false);
    expect(matches("[!ab].js", "c.js")).toBe(true);
    expect(matches("a(1)+.js", "a(1)+.js")).toBe(true);
    expect(matches("a.js", "abjs")).toBe(false);
    expect(() => globToRegExp("{a,b")).toThrow("unclosed {");
  });
});

describe("shellTimeout", () => {
  it("defaults to 120 seconds and stays within 1-600", () => {
    expect(shellTimeout()).toBe(120);
    expect(shellTimeout(5)).toBe(5);
    expect(shellTimeout(10_000)).toBe(600);
    expect(shellTimeout(-3)).toBe(1);
    expect(shellTimeout("soon")).toBe(120);
  });
});

describe("read_file", () => {
  it("returns long files in whole-line parts that say where to continue", async () => {
    await inTempDir(async () => {
      // 2000 lines of 10 characters each (with the line break): twice the output limit.
      const lines = Array.from({ length: 2000 }, (_, i) => String(i + 1).padStart(9, "0"));
      mkdirSync("src");
      writeFileSync("src/long.txt", `${lines.join("\r\n")}\r\n`);

      expect(await runTool("read_file", { path: "src/long.txt" })).toBe(
        `${lines.slice(0, 1000).join("\n")}\n[showing lines 1-1000 of 2000; continue with start_line=1001]`,
      );
      expect(await runTool("read_file", { path: "src/long.txt", start_line: 1001 })).toBe(lines.slice(1000).join("\n"));
    });
  });

  it("rejects binary files and bad ranges, and says when a file is empty", async () => {
    await inTempDir(async () => {
      mkdirSync("src");
      writeFileSync("src/image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      writeFileSync("src/empty.txt", "");
      writeFileSync("src/a.txt", "one\ntwo\n");

      await expect(runTool("read_file", { path: "src/image.png" })).rejects.toThrow("binary file");
      expect(await runTool("read_file", { path: "src/empty.txt" })).toBe("(empty file)");
      await expect(runTool("read_file", { path: "src/a.txt", start_line: 3 })).rejects.toThrow("Line 3 is outside the file (2 lines)");
      await expect(runTool("read_file", { path: "src/a.txt", start_line: 2, end_line: 1 })).rejects.toThrow("before start_line");
    });
  });
});

describe("line endings", () => {
  it("edits CRLF files using the LF strings models write, and keeps them CRLF", async () => {
    await inTempDir(async () => {
      mkdirSync("src");
      writeFileSync("src/a.js", "function a() {\r\n  return 1;\r\n}\r\n");

      expect(await runTool("read_file", { path: "src/a.js" })).toBe("function a() {\n  return 1;\n}");
      await runTool("edit_file", { path: "src/a.js", old_string: "{\n  return 1;\n}", new_string: "{\n  // two\n  return 2;\n}" });
      await runTool("edit_file", { path: "src/a.js", old_string: "function a()", new_string: "// a\nfunction a()" });

      expect(readFileSync("src/a.js", "utf8")).toBe("// a\r\nfunction a() {\r\n  // two\r\n  return 2;\r\n}\r\n");
    });
  });

  it("keeps an existing file's line endings when writing or appending", async () => {
    await inTempDir(async () => {
      mkdirSync("src");
      writeFileSync("src/crlf.txt", "a\r\nb\r\n");
      writeFileSync("src/lf.txt", "a\nb\n");

      await runTool("write_file", { path: "src/crlf.txt", content: "x\ny\n" });
      await runTool("append_file", { path: "src/crlf.txt", content: "z\n" });
      await runTool("write_file", { path: "src/lf.txt", content: "x\r\ny\r\n" });
      await runTool("write_file", { path: "src/new.txt", content: "x\r\ny\n" });

      expect(readFileSync("src/crlf.txt", "utf8")).toBe("x\r\ny\r\nz\r\n");
      expect(readFileSync("src/lf.txt", "utf8")).toBe("x\ny\n");
      expect(readFileSync("src/new.txt", "utf8")).toBe("x\r\ny\n"); // a new file is written as given
    });
  });
});
