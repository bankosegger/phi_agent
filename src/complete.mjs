import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_COMPLETIONS = 200;

// The files and folders in `dir` whose names start with `start`, as names, folders ending in /.
// Hidden ones only when `start` begins with a dot, as in a shell.
function entriesStartingWith(dir, start) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const caseless = process.platform === "win32" || process.platform === "darwin";
  const matches = (name) => (caseless ? name.toLowerCase().startsWith(start.toLowerCase()) : name.startsWith(start));
  return entries
    .filter((entry) => matches(entry.name) && (start.startsWith(".") || !entry.name.startsWith(".")))
    .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
    .sort();
}

/**
 * Tab completion for the prompt: command names after a "/", model IDs after "/model ", and
 * otherwise the path the last word starts, from the project folder (`cwd`) unless it is
 * absolute: "src/ap" becomes "src/app.js", and "@docs/m" becomes "@docs/mockup.png".
 * Returns [completions, the end of the line they replace], as readline's completer does.
 */
export function completeLine(line, { commands = [], models = [], cwd = process.cwd() } = {}) {
  // A command is a slash and letters; "/home/me/sh" is a path.
  if (/^\/[a-z]*$/i.test(line)) {
    return [commands.filter((command) => command.startsWith(line.toLowerCase())), line];
  }
  const model = line.match(/^\/model\s+(\S*)$/i);
  if (model) {
    return [models.filter((id) => id.startsWith(model[1])).slice(0, MAX_COMPLETIONS), model[1]];
  }

  // The last word, without an @ in front: that stays.
  const path = line.match(/(?:^|\s)@?([^\s@]+)$/)?.[1];
  if (!path) return [[], line];
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  const folder = path.slice(0, cut);
  const dir = isAbsolute(folder || ".") ? folder : join(cwd, folder);
  const names = entriesStartingWith(dir, path.slice(cut));
  return [names.slice(0, MAX_COMPLETIONS).map((name) => folder + name), path];
}
