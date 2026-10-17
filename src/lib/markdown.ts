/**
 * Markdown helpers that are pure, so they can be tested without React.
 *
 * The rendering half lives in `src/components/markdown.tsx`. This file holds
 * the two decisions that are worth testing on their own: which URLs are
 * allowed to become links, and how to flatten markdown back to plain text.
 */

/**
 * Schemes a link in a concept body is allowed to use.
 *
 * Concept bodies are untrusted: they are written from conversation content,
 * which is exactly the material an indirect prompt injection arrives in. The
 * renderer never emits raw HTML, so an anchor's href is the one remaining way
 * to get an executable scheme onto the page. `javascript:`, `data:` and
 * `vbscript:` are all live XSS vectors in an href and are refused here.
 *
 * Allowing a scheme-relative URL (`//evil.test`) would be a hole too: the
 * browser resolves it against the current origin's protocol and navigates
 * off-site, so it is treated as absolute and rejected unless it parses to an
 * allowed scheme (it does not).
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns the href if it is safe to render, otherwise undefined.
 *
 * Relative and anchor links are allowed through unchanged: they cannot leave
 * the origin and cannot carry a scheme.
 */
export function safeHref(href?: string | null): string | undefined {
  if (!href) return undefined;
  const value = href.trim();
  if (value === "") return undefined;

  // Control characters are stripped before parsing. `java\nscript:alert(1)`
  // is a real bypass: browsers ignore the newline, naive parsers do not.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");

  // Fragment and root-relative links never carry a scheme.
  if (cleaned.startsWith("#") || cleaned.startsWith("/")) {
    // ...except a protocol-relative URL, which also starts with a slash.
    if (cleaned.startsWith("//")) return undefined;
    return cleaned;
  }

  // Anything with a scheme must parse, and must parse to one we allow. A
  // bare relative path ("notes/raft.md") throws here and is allowed below.
  try {
    const url = new URL(cleaned);
    return ALLOWED_SCHEMES.has(url.protocol) ? cleaned : undefined;
  } catch {
    // Not absolute. Reject anything that still looks like it is reaching for
    // a scheme, and let ordinary relative paths through.
    return /^[a-z][a-z0-9+.-]*:/i.test(cleaned) ? undefined : cleaned;
  }
}

/**
 * Flatten markdown to readable plain text.
 *
 * For search snippets and anywhere else a single line is wanted. Rendering
 * markdown inside a 220-character excerpt produces a broken fragment of a
 * document; showing the raw source produces `## Consensus **safety**`. This
 * produces neither.
 *
 * Deliberately not a parser. It runs over untrusted text on a hot path, and
 * every pattern here is anchored and bounded so it cannot backtrack badly.
 */
export function plainText(markdown: string): string {
  if (!markdown) return "";

  return (
    markdown
      // Fenced code: keep the code, drop the fence and the language tag.
      .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
      .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, "$1")
      // Images before links: ![alt](src) keeps nothing useful, so drop it.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // Links keep their text.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Reference-style links and the definitions they point at.
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/^\s*\[[^\]]+\]:.*$/gm, "")
      // Inline code.
      .replace(/`([^`]*)`/g, "$1")
      // Heading hashes, blockquote markers, list bullets, numbered markers.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s{0,3}[-*+]\s+/gm, "")
      .replace(/^\s{0,3}\d{1,9}[.)]\s+/gm, "")
      // Task list checkboxes, left behind by the bullet strip above.
      .replace(/^\[([ xX])\]\s+/gm, "")
      // Thematic breaks and setext underlines.
      .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, "")
      .replace(/^\s{0,3}(={2,}|-{2,})\s*$/gm, "")
      // Emphasis. Bounded character classes, no nested quantifiers.
      .replace(/(\*\*\*|___)([^*_]+)\1/g, "$2")
      .replace(/(\*\*|__)([^*_]+)\1/g, "$2")
      .replace(/(\*|_)([^*_]+)\1/g, "$2")
      .replace(/~~([^~]+)~~/g, "$1")
      // Table alignment rows, before the pipes they are made of are collapsed
      // away. GFM accepts a single dash per column ("| - | - |"), so this
      // cannot require two, and it must also handle tables written without
      // outer pipes ("--- | ---"). Any line made only of dashes, colons,
      // pipes and spaces is one: a real row has content in it.
      .replace(/^[ \t]*[-:|][ \t:|-]*$/gm, "")
      .replace(/\s*\|\s*/g, " ")
      // Collapse the whitespace all of that left behind.
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Flatten, then cut to length on a word boundary. */
export function excerpt(markdown: string, max = 220): string {
  const text = plainText(markdown);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
