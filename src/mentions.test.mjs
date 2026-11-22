import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mentionParts } from "./mentions.mjs";

// A folder with these files, as both the project (cwd) and the home folder.
function folder(files) {
  const root = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  for (const [name, content] of Object.entries(files)) {
    const dir = join(root, ...name.split("/").slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return { cwd: root, home: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("mentionParts", () => {
  it("attaches @-mentioned text files as file parts, in order, each once", () => {
    const { cwd, home, cleanup } = folder({ "src/app.js": "console.log(1)\n", "README.md": "# Hi\n", "notes.txt": "remember\n" });
    try {
      const { parts, leftOut } = mentionParts("look at @src/app.js and @README.md, plus @src/app.js again. @notes.txt.", { cwd, home });
      expect(leftOut).toEqual([]);
      expect(parts.map((p) => p.shown)).toEqual(["@src/app.js", "@README.md", "@notes.txt"]);
      expect(parts[0].type).toBe("text");
      expect(parts[0].text).toBe('<file path="src/app.js">\nconsole.log(1)\n\n</file>');
    } finally {
      cleanup();
    }
  });

  it("leaves bare paths alone: only @ names a file", () => {
    const { cwd, home, cleanup } = folder({ "src/app.js": "x\n", "run.js": "y\n" });
    try {
      const { parts, leftOut } = mentionParts("run node /abs/run.js on src/app.js", { cwd, home });
      expect(parts).toEqual([]);
      expect(leftOut).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("reads quoted paths with spaces, ~ paths and file:// URLs after @", () => {
    const { cwd, home, cleanup } = folder({ "my file.js": "a\n", "home.txt": "b\n", "other.txt": "c\n" });
    try {
      const url = pathToFileURL(join(cwd, "other.txt")).href;
      const { parts } = mentionParts(`@"my file.js" @~/home.txt @'${url}'`, { cwd, home });
      expect(parts.map((p) => p.shown)).toEqual(["@my file.js", "@~/home.txt", `@${url}`]);
      expect(parts[0].text).toContain("a\n");
      expect(parts[1].text).toContain("b\n");
      expect(parts[2].text).toContain("c\n");
    } finally {
      cleanup();
    }
  });

  it("attaches a file only once, however it is named", () => {
    const { cwd, home, cleanup } = folder({ "src/app.js": "x\n" });
    try {
      const url = pathToFileURL(join(cwd, "src/app.js")).href;
      const { parts } = mentionParts(`@src/app.js @./src/app.js @'${url}'`, { cwd, home });
      expect(parts.map((p) => p.shown)).toEqual(["@src/app.js"]);
    } finally {
      cleanup();
    }
  });

  it("leaves images to imagePathsIn, and files that don't exist alone", () => {
    const { cwd, home, cleanup } = folder({ "pic.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]) });
    try {
      const { parts, leftOut } = mentionParts("@pic.png @nope.js", { cwd, home });
      expect(parts).toEqual([]);
      expect(leftOut).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("leaves out files that may hold secrets, that are too big, or aren't text", () => {
    const { cwd, home, cleanup } = folder({
      ".env": "KEY=abc\n",
      "big.txt": "x".repeat(101 * 1024),
      "blob.bin": Buffer.from([0x00, 0x01, 0x02]),
    });
    try {
      const { parts, leftOut } = mentionParts("@.env @big.txt @blob.bin", { cwd, home });
      expect(parts).toEqual([]);
      expect(leftOut.map(({ shown, reason }) => [shown, reason])).toEqual([
        ["@.env", "it may hold secrets, like API keys, and what the model reads goes to its provider"],
        ["@big.txt", "101 KB is over the 100 KB an @ can attach; the model can read_file it in parts"],
        ["@blob.bin", "it isn't a text file"],
      ]);
    } finally {
      cleanup();
    }
  });
});
