// fetch_url: downloads a web page, or other text, and turns HTML into readable text with links.

const FETCH_TIMEOUT_MS = 30_000;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
// Recently fetched pages, so reading a long page part by part downloads it once.
const CACHE_SIZE = 5;
const CACHE_MS = 10 * 60_000;
const USER_AGENT = "Mozilla/5.0 (compatible; TinyAgent/1.0; coding agent)";
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|ecmascript|x-javascript|x-sh|toml|yaml|x-yaml|ld\+json|xhtml\+xml)|[^;]*\+(json|xml))/i;

const ENTITIES = new Map(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ensp: " ",
    emsp: " ",
    thinsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    laquo: "«",
    raquo: "»",
    bull: "•",
    middot: "·",
    copy: "©",
    reg: "®",
    trade: "™",
    deg: "°",
    times: "×",
    divide: "÷",
    plusmn: "±",
    larr: "←",
    rarr: "→",
    uarr: "↑",
    darr: "↓",
    harr: "↔",
    para: "¶",
    sect: "§",
    euro: "€",
    pound: "£",
    yen: "¥",
    cent: "¢",
    shy: "",
    zwj: "",
    zwnj: "",
  }),
);

/** Decodes HTML character references: named ones (common ones only), decimal and hex. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, code) => {
    if (code[0] !== "#") return ENTITIES.get(code) ?? ENTITIES.get(code.toLowerCase()) ?? match;
    const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

// The text in a bit of HTML, on one line. Character references are left for the caller to decode.
function plain(html) {
  return stripTags(html).replace(/\s+/g, " ").trim();
}

// What isn't content: code, styles, page furniture, and controls.
const REMOVED = /<(script|style|noscript|template|svg|canvas|iframe|object|nav|aside|footer|button|select|dialog)\b[\s\S]*?<\/\1\s*>/gi;
// Tags that start or end a paragraph, with a blank line, or just a line.
const PARAGRAPH_TAGS = /<\/?(p|blockquote|table|figure|section|article|main|details|hr|form|fieldset|address|center)\b[^>]*>/gi;
const LINE_TAGS = /<\/?(div|header|ul|ol|dl|dt|dd|tr|thead|tbody|tfoot|caption|summary|figcaption)\b[^>]*>/gi;
// Stand-ins for breaks until runs of them are merged: a tag closing one block and the next
// opening another make one break, not two.
const LINE = "\u0001";
const PARAGRAPH = "\u0002";

// Whether a list is mostly links, like a site's menu or a table of contents.
function isLinkList(html) {
  if ((html.match(/<li\b/gi)?.length ?? 0) < 5) return false;
  const linkText = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].reduce((sum, [, inner]) => sum + plain(inner).length, 0);
  return linkText >= 0.7 * plain(html).length;
}

// The HTML without its lists of links (outermost lists only: a menu's submenus go with it).
function withoutLinkLists(html) {
  let result = "";
  let copied = 0;
  let depth = 0;
  let start = 0;
  for (const tag of html.matchAll(/<(\/?)(?:ul|ol)\b[^>]*>/gi)) {
    if (!tag[1]) {
      if (depth++ === 0) start = tag.index;
    } else if (depth > 0 && --depth === 0) {
      const end = tag.index + tag[0].length;
      if (isLinkList(html.slice(start, end))) {
        result += `${html.slice(copied, start)} `;
        copied = end;
      }
    }
  }
  return result + html.slice(copied);
}

/**
 * Readable text for an HTML page: the page's main content (its <main> or <article>, if it has
 * one), with headings as "#" lines, list items as "- " lines, links as [text](url) with `baseUrl`
 * resolving relative ones, code blocks in ``` fences, and table cells separated by " | ".
 * Scripts, styles, navigation and footers are left out, and so are lists that are mostly links,
 * unless that would leave hardly anything. Returns { title, text }.
 */
export function htmlToText(html, baseUrl) {
  const title = decodeEntities(plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? ""));

  let body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<head\b[\s\S]*?<\/head\s*>/i, "");
  body = body.replace(REMOVED, " ");
  body = body.match(/<main\b[^>]*>([\s\S]*)<\/main\s*>/i)?.[1] ?? body.match(/<article\b[^>]*>([\s\S]*)<\/article\s*>/i)?.[1] ?? body;

  const text = bodyText(withoutLinkLists(body), baseUrl);
  return { title, text: text.length >= 300 ? text : bodyText(body, baseUrl) };
}

function bodyText(body, baseUrl) {
  // Code blocks keep their spacing: set them aside until the rest has been tidied.
  const blocks = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, code) => {
    const text = decodeEntities(stripTags(code.replace(/<br\s*\/?>/gi, "\n"))).replace(/^\n+|\s+$/g, "");
    blocks.push(`\`\`\`\n${text}\n\`\`\``);
    return `${PARAGRAPH}\0${blocks.length - 1}\0${PARAGRAPH}`;
  });

  body = body
    .replace(/\s+/g, " ")
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, h1, h2, h3, inner) => {
      const text = plain(inner);
      const href = decodeEntities(h1 ?? h2 ?? h3 ?? "").trim();
      // A heading's "#" or "¶" permalink, or an icon without text, says nothing.
      if (!text || (href.startsWith("#") && /^[#¶§🔗]$/u.test(decodeEntities(text)))) return "";
      if (href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) return text;
      try {
        return `[${text}](${new URL(href, baseUrl).href})`;
      } catch {
        return text;
      }
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, inner) => `${PARAGRAPH}${"#".repeat(Number(level))} ${plain(inner)}${PARAGRAPH}`)
    .replace(/<li\b[^>]*>/gi, `${LINE}- `)
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, code) => `\`${plain(code)}\``)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(PARAGRAPH_TAGS, PARAGRAPH)
    .replace(LINE_TAGS, LINE);

  return (
    decodeEntities(stripTags(body))
      // A run of breaks is a blank line if one of them ends a paragraph (or two are <br>s).
      .replace(/[\s\u0001\u0002]*[\n\u0001\u0002][\s\u0001\u0002]*/g, (run) =>
        run.includes(PARAGRAPH) || run.split("\n").length > 2 ? "\n\n" : "\n",
      )
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").replace(/(\s*\|)+\s*$/, "").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .replace(/\0(\d+)\0/g, (_, i) => blocks[Number(i)])
  );
}

// The body as text, up to MAX_PAGE_BYTES, in the charset the response names (UTF-8 otherwise).
async function readText(response) {
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
  }
  const bytes = Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES);
  const charset = response.headers.get("content-type")?.match(/charset="?([\w-]+)/i)?.[1];
  let decoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return { text: decoder.decode(bytes), truncated: size >= MAX_PAGE_BYTES };
}

const cache = new Map(); // url -> { page, fetchedAt }

// Downloads `url` (http or https) and returns { url (after redirects), title, text, truncated }.
async function getPage(url, signal) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.page;

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new Error(`${url} didn't answer within ${FETCH_TIMEOUT_MS / 1000} seconds`);
    throw new Error(`couldn't fetch ${url}: ${error.cause?.message ?? error.message}`);
  }

  const type = response.headers.get("content-type") ?? "";
  if (type && !TEXT_TYPES.test(type)) {
    await response.body?.cancel();
    throw new Error(`${response.url || url} is ${type.split(";")[0]}, not a web page or text`);
  }
  const { text: raw, truncated } = await readText(response);
  if (!type && raw.slice(0, 1024).includes("\0")) throw new Error(`${response.url || url} isn't text`);

  const isHtml = /html/i.test(type) || (!type && /^\s*<(!doctype html|html)\b/i.test(raw));
  const { title, text } = isHtml ? htmlToText(raw, response.url || url) : { title: "", text: raw };
  if (!response.ok) {
    const excerpt = text.slice(0, 300).replace(/\s+/g, " ").trim();
    throw new Error(`${response.url || url} answered ${response.status} ${response.statusText}${excerpt ? `: ${excerpt}` : ""}`);
  }

  const page = { url: response.url || url, title, text, raw, truncated };
  cache.delete(url);
  cache.set(url, { page, fetchedAt: Date.now() });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return page;
}

/** Checks that `url` is an http or https URL, and returns it as a URL. */
export function webUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    throw new Error(`${url} isn't a URL; give a full one, like https://example.com/page`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("fetch_url only fetches http and https URLs");
  return parsed;
}

const SEARCH_URL = "https://html.duckduckgo.com/html/";

/**
 * The results of a web search, parsed from a search page's HTML: the anchors marked as results
 * (class `result__a`), each with its title, URL (DuckDuckGo's redirect unwrapped) and the
 * snippet that follows it, up to `maxResults`. Ads (`result--ad`) and repeats are left out.
 */
export function parseSearchResults(html, baseUrl, maxResults = 8) {
  const results = [];
  const seen = new Set();
  let at = 0;
  while (results.length < maxResults) {
    const open = html.indexOf("<a ", at);
    if (open === -1) break;
    const tagEnd = html.indexOf(">", open);
    const close = html.toLowerCase().indexOf("</a", tagEnd);
    if (tagEnd === -1 || close === -1) break;
    const attrs = html.slice(open + 3, tagEnd);
    at = close + 4;
    if (!attrs.includes("result__a")) continue;
    // An ad's anchor sits in a div marked result--ad.
    const divStart = html.lastIndexOf("<div", open);
    if (divStart !== -1 && html.slice(divStart, html.indexOf(">", divStart)).includes("result--ad")) continue;
    const href = attrs.match(/href="([^"]*)"/i)?.[1] ?? attrs.match(/href='([^']*)'/i)?.[1] ?? "";
    let url;
    try {
      url = new URL(decodeEntities(href), baseUrl).href;
    } catch {
      continue;
    }
    // DuckDuckGo links through a redirect; the real address is its uddg parameter.
    if (url.includes("uddg=")) {
      try {
        url = new URL(url).searchParams.get("uddg") ?? url;
      } catch {
        // keep the redirect URL
      }
    }
    const title = decodeEntities(stripTags(html.slice(tagEnd + 1, close))).replace(/\s+/g, " ").trim();
    const snippet = decodeEntities(stripTags(html.slice(at).match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1] ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Search the web for `query` (DuckDuckGo's HTML endpoint by default, no API key needed) and
 * return the top results as text: numbered, each with its title, URL and a short snippet.
 */
export async function webSearch(query, { maxResults = 8, signal, endpoint = SEARCH_URL } = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("web_search needs a query");
  const page = await getPage(`${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}`, signal);
  const results = parseSearchResults(page.raw, page.url, Math.max(1, Math.min(10, Math.floor(Number(maxResults)) || 8)));
  if (!results.length) return `No results for ${q}.`;
  return [`Search results for ${q}:`, "", ...results.flatMap((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, r.snippet && `   ${r.snippet}`].filter(Boolean))].join("\n");
}

/**
 * The text of the page at `url`, from character `start`, at most `maxChars` of it. Says the
 * page's title, where a redirect led, and where to continue when the page is longer.
 */
export async function fetchUrl(url, { start = 0, maxChars = 10_000, signal } = {}) {
  const requested = webUrl(url).href;
  const page = await getPage(requested, signal);

  const from = Math.min(Math.max(0, Math.floor(Number(start)) || 0), page.text.length);
  let to = Math.min(page.text.length, from + maxChars);
  // End a part at a line break, unless that would make it much shorter.
  const lineEnd = page.text.lastIndexOf("\n", to);
  if (to < page.text.length && lineEnd > from + maxChars / 2) to = lineEnd + 1;

  const header = [page.title && `Title: ${page.title}`, page.url !== requested && `URL: ${page.url}`].filter(Boolean);
  const notes = [];
  if (to < page.text.length) notes.push(`[showing characters ${from + 1}-${to} of ${page.text.length}; continue with start=${to}]`);
  else if (from > 0) notes.push(`[showing characters ${from + 1}-${to} of ${page.text.length}]`);
  if (page.truncated) notes.push(`[the page was cut off at ${MAX_PAGE_BYTES / 1024 / 1024} MB]`);

  const body = page.text.slice(from, to).trimEnd() || "(no text)";
  return [...(header.length ? [header.join("\n"), ""] : []), body, ...notes].join("\n");
}
