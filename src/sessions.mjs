import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ignoreAgentFolder } from "./tools.mjs";

// Conversations are saved in the project, under .agent/sessions, after every task, so a later
// session can continue one: in a file per conversation, named after when it started.

export const SESSIONS_DIR = ".agent/sessions";
// What was entered at the prompt, one line each, oldest first, for the up arrow.
export const HISTORY_FILE = ".agent/history";
const KEEP_SESSIONS = 30;
const VERSION = 1;

// The conversation files, most recently saved first.
function sessionFiles(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const saved = new Map(names.map((name) => [name, statSync(join(dir, name)).mtimeMs]));
  return names.sort((a, b) => saved.get(b) - saved.get(a) || (a < b ? 1 : -1));
}

/** A new conversation's file, named after `now`. */
export function newSessionFile(now = new Date(), dir = SESSIONS_DIR) {
  return join(dir, `${now.toISOString().replace(/[:.]/g, "-")}.json`);
}

/**
 * Saves a conversation: { messages, title (its first task), lastTask, tasks (how many), created }.
 * The file is replaced in one step, so a crash can't leave half of it. Only the KEEP_SESSIONS
 * conversations saved last are kept.
 */
export function saveSession(file, session, dir = SESSIONS_DIR) {
  mkdirSync(dir, { recursive: true });
  ignoreAgentFolder();
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: VERSION, ...session, updated: new Date().toISOString() }));
  renameSync(temp, file);
  for (const old of sessionFiles(dir).slice(KEEP_SESSIONS)) rmSync(join(dir, old), { force: true });
}

/** A saved conversation, as saveSession wrote it, with its `file`. Throws if it can't be read. */
export function loadSession(file) {
  let session;
  try {
    session = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`couldn't read the saved conversation ${file}: ${error.message}`);
  }
  if (!Array.isArray(session?.messages) || session.messages[0]?.role !== "system") {
    throw new Error(`${file} isn't a saved conversation`);
  }
  return { ...session, file };
}

/** The lines entered at the prompt before, newest first, as readline keeps them. */
export function loadHistory(file = HISTORY_FILE) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

/** Saves the prompt's history (newest first). */
export function saveHistory(lines, file = HISTORY_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  ignoreAgentFolder();
  writeFileSync(file, lines.length ? `${[...lines].reverse().join("\n")}\n` : "");
}

/**
 * The saved conversations, the one saved last first, without their messages but with how many
 * there are (`messageCount`). Unreadable files are skipped.
 */
export function listSessions(dir = SESSIONS_DIR) {
  const sessions = [];
  for (const name of sessionFiles(dir)) {
    try {
      const { messages, ...session } = loadSession(join(dir, name));
      sessions.push({ ...session, messageCount: messages.length });
    } catch {
      // not a conversation
    }
  }
  return sessions;
}
