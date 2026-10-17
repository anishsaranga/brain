/**
 * Checks for markdown rendering and the link guard.
 *
 *   npm run markdown:check
 *
 * No database and no container: this is all pure functions plus one
 * server-side React render, so it runs on the host in under a second.
 *
 * The reason it exists is the threat model rather than the formatting.
 * Concept bodies are written out of conversation content, which is exactly
 * the material an indirect prompt injection arrives in, and they are rendered
 * into a page that holds an authenticated session. Two properties have to
 * hold and both are invisible when they break:
 *
 *   1. Embedded HTML in a body never becomes live DOM.
 *   2. A link cannot carry an executable scheme.
 *
 * The first is a property of react-markdown with no rehype-raw. The second is
 * ours, in safeHref, and is the one a careless refactor could undo.
 *
 * Exits 1 on any failure.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

const { safeHref, plainText, excerpt } = await import("@/lib/markdown");
const { default: Markdown } = await import("@/components/markdown");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err && err.message ? err.message : err}`);
  }
}

const section = (t) => console.log(`\n${t}`);
const render = (md) => renderToStaticMarkup(React.createElement(Markdown, null, md));

console.log("markdown-check");

// ── The link guard ───────────────────────────────────────────────────────────

section("safeHref");

check("it allows the three schemes a note legitimately needs", () => {
  assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHref("http://example.com"), "http://example.com");
  assert.equal(safeHref("mailto:someone@example.com"), "mailto:someone@example.com");
});

check("it allows relative and fragment links", () => {
  assert.equal(safeHref("/c/abc-123"), "/c/abc-123");
  assert.equal(safeHref("#heading"), "#heading");
  assert.equal(safeHref("notes/raft.md"), "notes/raft.md");
});

check("it refuses executable schemes", () => {
  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    assert.equal(safeHref(href), undefined, `${href} must be refused`);
  }
});

check("it refuses a scheme split by a control character", () => {
  // Browsers strip these before resolving the URL, so a parser that does not
  // see "javascript:" where the browser does is a bypass, not a near miss.
  assert.equal(safeHref("java\nscript:alert(1)"), undefined);
  assert.equal(safeHref("java\tscript:alert(1)"), undefined);
  assert.equal(safeHref("java\u0000script:alert(1)"), undefined);
});

check("it refuses protocol-relative URLs", () => {
  // These look relative and are not: the browser resolves the scheme from
  // the current page and navigates off-origin.
  assert.equal(safeHref("//evil.example"), undefined);
});

check("it refuses nothing at all", () => {
  assert.equal(safeHref(""), undefined);
  assert.equal(safeHref("   "), undefined);
  assert.equal(safeHref(null), undefined);
  assert.equal(safeHref(undefined), undefined);
});

// ── Rendering ────────────────────────────────────────────────────────────────

section("rendering");

check("markdown becomes elements, not literal characters", () => {
  const html = render(
    "# Consensus\n\nRaft is **safe** and *live*.\n\n- leader election\n- log replication\n",
  );
  assert.match(html, /<h1[^>]*>Consensus<\/h1>/);
  assert.match(html, /<strong>safe<\/strong>/);
  assert.match(html, /<em>live<\/em>/);
  assert.match(html, /<li>leader election<\/li>/);
  assert.ok(!html.includes("**safe**"), "the asterisks must not survive");
  assert.ok(!html.includes("# Consensus"), "the hash must not survive");
});

check("gfm tables, strikethrough and task lists render", () => {
  const html = render(
    "| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] not\n",
  );
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /type="checkbox"/);
});

check("fenced code is preserved verbatim", () => {
  const html = render("```js\nconst x = 1 < 2;\n```");
  assert.match(html, /<pre>/);
  assert.match(html, /const x = 1 &lt; 2;/);
});

// ── The two properties that matter ───────────────────────────────────────────

section("embedded HTML never becomes live DOM");

check("a script tag in a body does not survive", () => {
  const html = render("Before\n\n<script>alert(1)</script>\n\nAfter");
  assert.ok(!/<script/i.test(html), `a script element survived: ${html}`);
});

check("an event handler attribute does not survive", () => {
  const html = render('<img src="x" onerror="alert(1)">');
  // The whole tag comes back escaped to text, which is the safe outcome: the
  // string "onerror" is present but only as &quot;-quoted characters inside a
  // text node, so there is no element for it to be an attribute of. Assert
  // the property that matters rather than the absence of a substring.
  assert.ok(!/<img/i.test(html), `a live img element survived: ${html}`);
  assert.match(html, /&lt;img/, "the tag should be escaped into text");
});

check("an iframe does not survive", () => {
  const html = render('<iframe src="https://evil.example"></iframe>');
  assert.ok(!/<iframe/i.test(html), "an iframe survived");
});

section("links in rendered output");

check("a javascript: link renders as text, keeping the note intact", () => {
  const html = render("[click me](javascript:alert(1))");
  assert.ok(!/href="javascript/i.test(html), `a javascript href survived: ${html}`);
  // Refusing must not silently delete part of someone's note.
  assert.match(html, /click me/);
});

check("an external link is given rel and target", () => {
  const html = render("[docs](https://example.com)");
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /target="_blank"/);
});

check("an internal link is not sent to a new tab", () => {
  const html = render("[Raft](/c/abc-123)");
  assert.match(html, /href="\/c\/abc-123"/);
  assert.ok(!/target="_blank"/.test(html), "an internal link should stay in the tab");
});

check("an autolinked bare URL is guarded too", () => {
  // remark-gfm turns bare URLs into links, which bypasses the [](…) syntax.
  const html = render("see https://example.com/x for more");
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

// ── Flattening, for snippets ─────────────────────────────────────────────────

section("plainText");

check("it strips syntax without eating the content", () => {
  assert.equal(plainText("# Raft"), "Raft");
  assert.equal(plainText("**bold** and *italic*"), "bold and italic");
  assert.equal(plainText("- one\n- two"), "one two");
  assert.equal(plainText("1. one\n2. two"), "one two");
  assert.equal(plainText("> quoted"), "quoted");
  assert.equal(plainText("`code`"), "code");
  assert.equal(plainText("~~struck~~"), "struck");
  assert.equal(plainText("a\n\nb"), "a b");
});

check("links keep their text and lose their target", () => {
  assert.equal(plainText("see [the docs](https://example.com)"), "see the docs");
  assert.equal(plainText("![alt text](img.png)"), "");
  assert.equal(plainText("[ref][1]"), "ref");
});

check("fenced code keeps the code and loses the fence", () => {
  assert.equal(plainText("```js\nconst x = 1;\n```"), "const x = 1;");
});

check("a table flattens to its cells", () => {
  const out = plainText("| a | b |\n| - | - |\n| 1 | 2 |");
  assert.ok(out.includes("a b"), out);
  assert.ok(!out.includes("|"), out);
  assert.ok(!out.includes("-"), out);
});

check("underscores inside a word are left alone", () => {
  // snake_case identifiers are common in these notes and are not emphasis.
  assert.equal(plainText("call read_concept now"), "call read_concept now");
});

check("it is safe on empty and whitespace input", () => {
  assert.equal(plainText(""), "");
  assert.equal(plainText("   \n\n  "), "");
});

section("excerpt");

check("it cuts on a word boundary and marks the cut", () => {
  const out = excerpt("word ".repeat(80), 40);
  assert.ok(out.length <= 41, `too long: ${out.length}`);
  assert.ok(out.endsWith("…"), out);
  assert.ok(!out.includes("wor…"), "should not cut mid-word");
});

check("short text is returned whole, with no ellipsis", () => {
  assert.equal(excerpt("# Short", 200), "Short");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
