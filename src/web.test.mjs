import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { decodeEntities, fetchUrl, htmlToText, webUrl } from "./web.mjs";

const PAGE = `<!doctype html>
<html>
<head><title>Guide &amp; Tips</title><style>body { color: red }</style></head>
<body>
<nav><a href="/">Home</a> <a href="/blog">Blog</a></nav>
<div class="banner">Sign up for our newsletter</div>
<main>
<h1>Getting <em>started</em><a href="#getting-started" class="anchor">#</a></h1>
<p>Install it with <code>npm i demo</code>, then read the <a href="api.html">API docs</a>.
Text across
lines &mdash; one paragraph.<img src="x.png" alt="logo"></p>
<ul><li>One</li><li>Two &lt;b&gt;</li></ul>
<pre><code class="language-js">if (a &lt; b) {
  run();
}
</code></pre>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>x</td><td>1</td></tr></table>
<p>Mail <a href="mailto:a@example.com">us</a>, or see <a href="#faq">the FAQ</a>.<a href="/x"><svg><path d="M0"/></svg></a></p>
<p>Escape <code>&lt;</code> as <code>&amp;lt;</code>.</p>
<script>document.write("not content")</script>
</main>
<footer>© 2026</footer>
</body>
</html>`;

const PAGE_TEXT = [
  "# Getting started",
  "",
  "Install it with `npm i demo`, then read the [API docs](http://host/docs/api.html). Text across lines — one paragraph.",
  "",
  "- One",
  "- Two <b>",
  "",
  "```",
  "if (a < b) {",
  "  run();",
  "}",
  "```",
  "",
  "Name | Value",
  "x | 1",
  "",
  "Mail us, or see the FAQ.",
  "",
  "Escape `<` as `&lt;`.",
].join("\n");

let server;
let base;
let hits = 0;

const ROUTES = {
  "/docs/guide.html": (res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE),
  "/data.json": (res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'),
  "/logo.png": (res) => res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0])),
  "/missing": (res) => res.writeHead(404, { "content-type": "text/html" }).end("<html><body><h1>Not found</h1><p>No such page.</p></body></html>"),
  "/moved": (res) => res.writeHead(302, { location: "/docs/guide.html" }).end(),
  "/latin1": (res) => res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9])),
  "/long": (res) => {
    hits++;
    const lines = Array.from({ length: 500 }, (_, i) => `line ${String(i + 1).padStart(3, "0")} ${"x".repeat(40)}`);
    res.writeHead(200, { "content-type": "text/plain" }).end(lines.join("\n"));
  },
  "/hang": () => {}, // never answers
};

beforeAll(async () => {
  server = createServer((req, res) => (ROUTES[req.url] ?? ((r) => r.writeHead(500).end()))(res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("htmlToText", () => {
  it("keeps the main content as readable text, with links, lists, code and tables", () => {
    const { title, text } = htmlToText(PAGE, "http://host/docs/guide.html");
    expect(title).toBe("Guide & Tips");
    expect(text).toBe(PAGE_TEXT);
  });

  it("leaves out lists that are mostly links, unless that leaves hardly anything", () => {
    const links = (n) => Array.from({ length: n }, (_, i) => `<li><a href="/p${i}">Page ${i}</a></li>`).join("");
    const content = `<p>${"Content. ".repeat(40).trim()}</p>`;
    const menu = `<div class="sidebar"><ul>${links(8)}<li><ul>${links(3)}</ul></li></ul></div>`;
    const shortList = `<ul>${links(3)}</ul>`;

    const { text } = htmlToText(`<body>${menu}${content}${shortList}</body>`, "https://example.com/");
    expect(text).toBe(`${"Content. ".repeat(40).trim()}\n\n- [Page 0](https://example.com/p0)\n- [Page 1](https://example.com/p1)\n- [Page 2](https://example.com/p2)`);

    // A page that is just a list of links, like an index, keeps it.
    expect(htmlToText(`<body><h1>Index</h1><ul>${links(6)}</ul></body>`, "https://example.com/").text).toMatch(/^# Index\n\n- \[Page 0\]\(https:\/\/example.com\/p0\)\n[\s\S]*- \[Page 5\]/);
  });

  it("reads the whole body when there is no main or article", () => {
    const html = "<html><body><div>First</div><div>Second <b>bold</b></div><br>Third</body></html>";
    expect(htmlToText(html, "https://example.com/")).toEqual({ title: "", text: "First\nSecond bold\nThird" });
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references, and leaves unknown ones", () => {
    expect(decodeEntities("&lt;a&gt; &amp;amp; &#169; &#x1F600; &nbsp;|&unknown; &constructor; &#0;")).toBe("<a> &amp; © 😀  |&unknown; &constructor; &#0;");
  });
});

describe("fetchUrl", () => {
  it("returns a page's title and text", async () => {
    const result = await fetchUrl(`${base}/docs/guide.html`);
    expect(result).toBe(`Title: Guide & Tips\n\n${PAGE_TEXT.replaceAll("http://host", base)}`);
  });

  it("says where a redirect led, and returns other text as it is", async () => {
    expect(await fetchUrl(`${base}/moved`)).toMatch(new RegExp(`^Title: Guide & Tips\\nURL: ${base}/docs/guide.html\\n\\n# Getting started`));
    expect(await fetchUrl(`${base}/data.json`)).toBe('{"ok":true}');
    expect(await fetchUrl(`${base}/latin1`)).toBe("café");
  });

  it("returns a long page in parts that end at a line break and say where to continue", async () => {
    hits = 0;
    const first = await fetchUrl(`${base}/long`, { maxChars: 1010 });
    // 1010 characters would end in line 21, so this part stops after line 20.
    expect(first).toMatch(/^line 001 x+\n[\s\S]*\nline 020 x+\n\[showing characters 1-1000 of 24999; continue with start=1000\]$/);

    const second = await fetchUrl(`${base}/long`, { start: 1000, maxChars: 1010 });
    expect(second.startsWith("line 021 ")).toBe(true);
    const last = await fetchUrl(`${base}/long`, { start: 24500, maxChars: 1010 });
    expect(last).toMatch(/^line 491 [\s\S]*\nline 500 x+\n\[showing characters 24501-24999 of 24999\]$/);
    // The page was downloaded once.
    expect(hits).toBe(1);
  });

  it("refuses what isn't text, and reports errors with what the server said", async () => {
    await expect(fetchUrl(`${base}/logo.png`)).rejects.toThrow("/logo.png is image/png, not a web page or text");
    await expect(fetchUrl(`${base}/missing`)).rejects.toThrow("/missing answered 404 Not Found: # Not found No such page.");
    await expect(fetchUrl("http://127.0.0.1:1/")).rejects.toThrow("couldn't fetch http://127.0.0.1:1/");
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(fetchUrl(`${base}/hang`, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("webUrl", () => {
  it("accepts only full http and https URLs", () => {
    expect(webUrl(" https://example.com/a?b=1 ").href).toBe("https://example.com/a?b=1");
    expect(() => webUrl("example.com")).toThrow("isn't a URL; give a full one");
    expect(() => webUrl("file:///etc/passwd")).toThrow("only fetches http and https URLs");
    expect(() => webUrl(undefined)).toThrow("isn't a URL");
  });
});
