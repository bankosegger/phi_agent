import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { imagePart, imagePathsIn } from "./images.mjs";

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tiny-agent-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEADERS = {
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
  "image/gif": Buffer.from("GIF89a\x01\x00", "latin1"),
  "image/webp": Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"),
};

describe("imagePart", () => {
  it("tells images apart by their contents, not their names", () => {
    inTempDir((dir) => {
      for (const [type, bytes] of Object.entries(HEADERS)) {
        const path = join(dir, `image-${type.split("/")[1]}.png`); // the extension doesn't matter
        writeFileSync(path, bytes);
        expect(imagePart(path)).toEqual({ type: "image_url", image_url: { url: `data:${type};base64,${bytes.toString("base64")}` } });
      }
    });
  });

  it("refuses files that aren't images, and images over 5 MB", () => {
    inTempDir((dir) => {
      writeFileSync(join(dir, "fake.png"), "not really a picture");
      expect(() => imagePart(join(dir, "fake.png"), "fake.png")).toThrow("fake.png isn't a PNG, JPEG, GIF or WebP image");
      // WebP shares its RIFF container with sound files.
      writeFileSync(join(dir, "sound.webp"), Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"));
      expect(() => imagePart(join(dir, "sound.webp"), "sound.webp")).toThrow("isn't a PNG, JPEG, GIF or WebP image");

      writeFileSync(join(dir, "huge.png"), Buffer.concat([HEADERS["image/png"], Buffer.alloc(5 * 1024 * 1024)]));
      expect(() => imagePart(join(dir, "huge.png"), "huge.png")).toThrow("huge.png is 5.0 MB; images can be at most 5 MB");
    });
  });
});

describe("imagePathsIn", () => {
  it("finds the images a message names by absolute path, file URL, ~/ or @", () => {
    inTempDir((dir) => {
      mkdirSync(join(dir, "project", "docs"), { recursive: true });
      mkdirSync(join(dir, "My Pictures"));
      const shot = join(dir, "shot.png");
      const spaced = join(dir, "My Pictures", "screen shot.JPG");
      const design = join(dir, "project", "docs", "ui.webp");
      for (const path of [shot, spaced, design]) writeFileSync(path, "");
      const options = { cwd: join(dir, "project"), home: dir };

      expect(imagePathsIn(`what's wrong in ${shot}?`, options)).toEqual([shot]);
      expect(imagePathsIn(`compare "${spaced}" and ${pathToFileURL(design).href}`, options)).toEqual([spaced, design]);
      expect(imagePathsIn("see @docs/ui.webp, and ~/shot.png.", options)).toEqual([design, shot]);
      if (process.platform !== "win32") {
        // macOS and Linux terminals escape the spaces of a dragged file.
        expect(imagePathsIn(spaced.replaceAll(" ", "\\ "), options)).toEqual([spaced]);
      }
    });
  });

  it("leaves out project paths without an @, files that don't exist, other files, and repeats", () => {
    inTempDir((dir) => {
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs", "ui.png"), "");
      writeFileSync(join(dir, "notes.txt"), "");
      const options = { cwd: dir, home: dir };

      expect(imagePathsIn("rename docs/ui.png to docs/main.png", options)).toEqual([]);
      expect(imagePathsIn(`${join(dir, "missing.png")} @missing.png ${join(dir, "notes.txt")}`, options)).toEqual([]);
      expect(imagePathsIn(`@docs/ui.png and again ${join(dir, "docs", "ui.png")}`, options)).toEqual([join(dir, "docs", "ui.png")]);
    });
  });
});
