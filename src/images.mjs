import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Images for models that can see them: files the model opens with view_image, and files the
// user names in a message.

const MAX_IMAGE_MB = 5; // the most some providers take
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_TYPES = [
  ["image/png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ["image/gif", (bytes) => bytes.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
];

/**
 * An image file as the part of a chat message that shows it to the model. Throws if the file
 * isn't a PNG, JPEG, GIF or WebP image, or is bigger than MAX_IMAGE_MB. `shown` names it in errors.
 */
export function imagePart(fullPath, shown = fullPath) {
  const { size } = statSync(fullPath);
  if (size > MAX_IMAGE_MB * 1024 * 1024) {
    throw new Error(`${shown} is ${(size / 1024 / 1024).toFixed(1)} MB; images can be at most ${MAX_IMAGE_MB} MB`);
  }
  const bytes = readFileSync(fullPath);
  const type = IMAGE_TYPES.find(([, matches]) => matches(bytes))?.[0];
  if (!type) throw new Error(`${shown} isn't a PNG, JPEG, GIF or WebP image`);
  return { type: "image_url", image_url: { url: `data:${type};base64,${bytes.toString("base64")}` } };
}

// The words of a message: a quoted path (with or without an @ in front), or a run of
// non-space characters, where a backslash keeps a space in the word, as a terminal pastes
// a dragged file.
export function words(text) {
  const BS = String.fromCharCode(92);
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const CR = String.fromCharCode(13);
  const found = [];
  for (const line of text.split(NL)) {
    let word = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        word += char;
        if (char === quote) {
          found.push(word);
          word = "";
          quote = null;
        }
      } else if ((char === '"' || char === "'") && line.indexOf(char, i + 1) !== -1) {
        word += char;
        quote = char;
      } else if (char === " " || char === TAB || char === CR) {
        if (word) {
          found.push(word);
          word = "";
        }
      } else if (char === BS && line[i + 1] === " ") {
        word += " ";
        i++;
      } else {
        word += char;
      }
    }
    if (word) found.push(word);
  }
  return found.map((raw) => {
    const at = raw.startsWith("@");
    let word = at ? raw.slice(1) : raw;
    if (word.length > 1 && ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")))) word = word.slice(1, -1);
    return at ? `@${word}` : word;
  });
}

/**
 * The image files a message names for the model to see: absolute paths (as dragging a file into
 * the terminal gives), file:// URLs, ~/ paths, and project paths after an @, like @docs/ui.png.
 * Only files that exist are returned, as full paths, each once.
 */
export function imagePathsIn(text, { cwd = process.cwd(), home = homedir() } = {}) {
  const paths = new Set();
  for (let word of words(text)) {
    word = word.replace(/[.,;:!?)\]]+$/, "");
    const named = word.startsWith("@");
    if (named) word = word.slice(1);
    if (!IMAGE_EXTENSION.test(word)) continue;

    let path = null;
    if (word.startsWith("file://")) {
      try {
        path = fileURLToPath(word);
      } catch {
        continue;
      }
    } else if (word.startsWith("~/") || word.startsWith("~\\")) {
      path = join(home, word.slice(2));
    } else if (isAbsolute(word)) {
      path = word;
    } else if (named) {
      path = resolve(cwd, word);
    }
    if (path && existsSync(path) && statSync(path).isFile()) paths.add(resolve(path));
  }
  return [...paths];
}
