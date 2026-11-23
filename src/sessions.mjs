import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLAN_NOTE } from "./agent-core.mjs";
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

// The saved conversations, the one saved last first, messages and all, each with its number in
// that order (from 1). Unreadable files are skipped, and get no number.
function readSessions(dir) {
  const sessions = [];
  for (const name of sessionFiles(dir)) {
    try {
      sessions.push({ ...loadSession(join(dir, name)), number: sessions.length + 1 });
    } catch {
      // not a conversation
    }
  }
  return sessions;
}

/**
 * The saved conversations, the one saved last first, without their messages but with how many
 * there are (`messageCount`), and each with its `number` in this list, from 1, which /resume
 * goes by. Unreadable files are skipped.
 */
export function listSessions(dir = SESSIONS_DIR) {
  return readSessions(dir).map(({ messages, ...session }) => ({ ...session, messageCount: messages.length }));
}

// What the user asked for in a conversation, oldest first: the text of each task, without what
// was attached to it (a file's content isn't something the user asked) or the note plan mode adds.
// The agent's own notes to the model, like a summary of earlier tasks, are user messages too.
function taskTexts(messages) {
  const texts = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const first = Array.isArray(message.content) ? message.content[0] : { type: "text", text: message.content };
    let text = first?.type === "text" ? String(first.text ?? "") : "";
    if (text.startsWith(PLAN_NOTE)) text = text.slice(PLAN_NOTE.length);
    if (text.trim()) texts.push(text.trim());
  }
  return texts;
}

/**
 * The saved conversations in which the user asked for something with each of `query`'s words in
 * it, in any case, listed and numbered as listSessions lists them. Each has `match`: the task
 * with most of the words its title lacks, or null when its title has them all. Without words,
 * that is all of them.
 */
export function searchSessions(query, dir = SESSIONS_DIR) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = [];
  for (const { messages, ...session } of readSessions(dir)) {
    const tasks = taskTexts(messages);
    const all = [session.title, session.lastTask, ...tasks].filter(Boolean).join("\n").toLowerCase();
    if (!words.every((word) => all.includes(word))) continue;

    // The title is shown anyway: the match shows where the words it lacks are.
    const title = (session.title ?? "").toLowerCase();
    const missing = words.filter((word) => !title.includes(word));
    let match = null;
    let most = 0;
    for (const task of [...tasks, session.lastTask ?? ""]) {
      const count = missing.filter((word) => task.toLowerCase().includes(word)).length;
      if (count > most) [match, most] = [task, count];
    }
    found.push({ ...session, messageCount: messages.length, match });
  }
  return found;
}

/** Deletes a saved conversation. */
export function deleteSession(file) {
  rmSync(file, { force: true });
}
