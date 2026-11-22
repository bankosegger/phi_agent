import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imagePathsIn, words } from "./images.mjs";
import { isSecretFile } from "./tools.mjs";

// Text files named in a message with @, like @src/app.js, are attached to it as file parts, so
// the model reads them without a tool call. Images named the same way go through imagePathsIn
// instead. Files that may hold secrets are left out (what the model reads goes to its provider),
// and so are files over MAX_TEXT_KB or that aren't text.

export const MAX_TEXT_KB = 100;

/**
 * The @-mentioned files in a message: { parts, leftOut }. Only @-words count — a bare path in a
 * message is just text — and only existing files: project paths after @, ~/, absolute paths and
 * file:// URLs. `parts` are message parts { type: "text", text, shown } in the order named, each
 * file once; `leftOut` are { shown, reason } for files that exist but weren't attached.
 */
export function mentionParts(text, { cwd = process.cwd(), home = homedir() } = {}) {
  const images = new Set(imagePathsIn(text, { cwd, home }));
  const parts = [];
  const leftOut = [];
  const seen = new Set();
  for (let word of words(text)) {
    word = word.replace(/[.,;:!?)\]]+$/, "");
    if (!word.startsWith("@")) continue;
    word = word.slice(1);
    if (!word) continue;

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
    } else {
      path = resolve(cwd, word);
    }
    const full = resolve(path);
    const shown = `@${word}`;
    if (seen.has(full)) continue;
    seen.add(full);
    if (images.has(full)) continue; // an image: attached by imagePathsIn
    if (!existsSync(full) || !statSync(full).isFile()) continue; // not a file: just a word
    if (isSecretFile(full)) {
      leftOut.push({ shown, reason: "it may hold secrets, like API keys, and what the model reads goes to its provider" });
      continue;
    }
    const { size } = statSync(full);
    if (size > MAX_TEXT_KB * 1024) {
      leftOut.push({ shown, reason: `${(size / 1024).toFixed(0)} KB is over the ${MAX_TEXT_KB} KB an @ can attach; the model can read_file it in parts` });
      continue;
    }
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 8192).includes(0)) {
      leftOut.push({ shown, reason: "it isn't a text file" });
      continue;
    }
    parts.push({ type: "text", shown, text: `<file path="${word}">\n${bytes.toString("utf8")}\n</file>` });
  }
  return { parts, leftOut };
}
