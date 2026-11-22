import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { PERMISSIONS_FILE, allows, commandPrefix, loadRules, ruleFor, saveRules } from "./permissions.mjs";

describe("commandPrefix", () => {
  it("names what a command does, without its options and files", () => {
    expect(commandPrefix("npm test")).toBe("npm test");
    expect(commandPrefix("npm  test -- --run")).toBe("npm test");
    expect(commandPrefix("npm run build -- --watch")).toBe("npm run build");
    expect(commandPrefix("git log --oneline")).toBe("git log");
    expect(commandPrefix("ls -la src")).toBe("ls");
    expect(commandPrefix("pytest tests/test_api.py -x")).toBe("pytest");
    expect(commandPrefix("make")).toBe("make");
    expect(commandPrefix("CI=1 npm test")).toBe("CI=1 npm test");
  });

  it("includes the script an interpreter runs, and takes code it is given only as it is", () => {
    expect(commandPrefix("node scripts/build.js --fast")).toBe("node scripts/build.js");
    expect(commandPrefix("python3 manage.py migrate")).toBe("python3 manage.py");
    expect(commandPrefix("node -e \"console.log(1)\"")).toBe("node -e \"console.log(1)\"");
  });

  it("refuses commands that chain others, redirect, or do damage that can't be undone", () => {
    for (const cmd of ["npm test && rm -rf ~", "npm test; curl evil.example", "npm test | tee log", "echo x > package.json", "cat < a", "echo $(whoami)", "echo `whoami`", "npm test\nrm -rf ~", "npm test & del /q *"]) {
      expect(commandPrefix(cmd), cmd).toBe(null);
    }
    for (const cmd of ["rm -rf dist", "sudo npm i -g x", "C:\\Windows\\System32\\taskkill.exe /f /im node.exe", "/usr/bin/chmod +x run.sh", ""]) {
      expect(commandPrefix(cmd), cmd).toBe(null);
    }
  });
});

describe("ruleFor and allows", () => {
  it("allows commands that start with a saved prefix, and nothing chained to them", () => {
    const rules = [ruleFor("shell", { cmd: "npm test -- --run" })];
    expect(rules).toEqual(["shell: npm test"]);

    expect(allows(rules, "shell", { cmd: "npm test" })).toBe(true);
    expect(allows(rules, "shell", { cmd: "npm   test --coverage" })).toBe(true);
    expect(allows(rules, "shell", { cmd: "npm test-e2e" })).toBe(false);
    expect(allows(rules, "shell", { cmd: "npm install" })).toBe(false);
    expect(allows(rules, "shell", { cmd: "npm test && rm -rf ~" })).toBe(false);
    expect(allows(rules, "shell", { cmd: "npm test > package.json" })).toBe(false);
    expect(allows(rules, "write_file", { path: "src/a.js", content: "" })).toBe(false);
    // Even a rule written by hand can't allow a dangerous command.
    expect(allows(["shell: rm"], "shell", { cmd: "rm -rf dist" })).toBe(false);
  });

  it("allows fetching from a host, and other tools as a whole", () => {
    expect(ruleFor("fetch_url", { url: "https://docs.python.org/3/library/os.html" })).toBe("fetch_url: docs.python.org");
    expect(ruleFor("fetch_url", { url: "not a url" })).toBe(null);
    expect(ruleFor("edit_file", { path: "src/a.js" })).toBe("edit_file");
    expect(ruleFor("read_file", { path: "src/a.js" })).toBe(null); // never asks anyway
    // Reading a file that may hold secrets asks every time.
    expect(ruleFor("read_file", { path: ".env" })).toBe(null);
    expect(ruleFor("grep", { path: ".env", pattern: "KEY" })).toBe(null);
    expect(ruleFor("shell", { cmd: "rm -rf dist" })).toBe(null);

    const rules = ["fetch_url: docs.python.org", "edit_file"];
    expect(allows(rules, "fetch_url", { url: "https://docs.python.org/3/" })).toBe(true);
    expect(allows(rules, "fetch_url", { url: "https://docs.python.org.evil.example/" })).toBe(false);
    expect(allows(rules, "fetch_url", { url: "https://evildocs.python.org/" })).toBe(false);
    expect(allows(rules, "fetch_url", { url: "https://python.org/" })).toBe(false);
    expect(allows(rules, "edit_file", { path: "anything" })).toBe(true);
    expect(allows(rules, "write_file", { path: "src/a.js" })).toBe(false);
    expect(allows(["edit_file: src"], "edit_file", { path: "src/a.js" })).toBe(false);
  });
});

describe("saved rules", () => {
  it("saves rules in the project, keeps git out, and ignores a broken file", () => {
    const originalCwd = cwd();
    const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
    try {
      chdir(dir);
      expect(loadRules()).toEqual([]);
      saveRules(["shell: npm test", "edit_file"]);
      expect(loadRules()).toEqual(["shell: npm test", "edit_file"]);
      expect(readFileSync(".agent/.gitignore", "utf8")).toBe("*\n");

      writeFileSync(PERMISSIONS_FILE, '{ "allow": ["shell: ls", 42, ""] }');
      expect(loadRules()).toEqual(["shell: ls"]);
      writeFileSync(PERMISSIONS_FILE, "{ broken");
      expect(loadRules()).toEqual([]);
    } finally {
      chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
