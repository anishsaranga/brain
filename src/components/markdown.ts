import { createElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeHref } from "@/lib/markdown";

/**
 * Render a concept body.
 *
 * `react-markdown` rather than a string-to-HTML library, and the reason is
 * the threat model rather than ergonomics. Concept bodies are untrusted: they
 * are written out of conversation content, which is the same material the MCP
 * tools already wrap in an untrusted-data envelope. A `marked` plus DOMPurify
 * pipeline would mean `dangerouslySetInnerHTML` and a server-side DOM, one
 * misconfiguration away from stored XSS in a page that holds a session.
 *
 * This builds a React element tree instead. It never sets inner HTML, and it
 * DROPS embedded HTML unless `rehype-raw` is added.
 *
 * NEVER ADD `rehype-raw`. It exists to turn the HTML inside a markdown
 * document back into live nodes, which is exactly the property being relied
 * on here. `scripts/markdown-check.mjs` asserts that a <script>, an
 * onerror attribute and an <iframe> all fail to survive a render.
 *
 * WHY THIS FILE IS .ts AND NOT .tsx: so that check script can import the real
 * component. Node strips types but cannot transform JSX, so a .tsx module
 * cannot be loaded by a plain `node` run, and a security boundary that can
 * only be tested through a browser is a security boundary nobody tests. Same
 * reasoning that moved the MCP auth decision out of its route handler.
 *
 * A server component by default, so none of the parser reaches the browser on
 * a read. The editor's preview imports it into a client component and does
 * pay for it, which is a fair trade for one authenticated user.
 */
export default function Markdown({ children }: { children: string }) {
  return createElement(
    "div",
    { className: "prose" },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        // The library sanitises URLs by default. Stating the policy here
        // rather than inheriting it means a dependency bump that loosens the
        // default cannot quietly widen what is accepted.
        urlTransform: (url: string) => safeHref(url) ?? "",
        components: {
          // A table is the one markdown element with an irreducible minimum
          // width, so on a narrow screen it drags the whole page sideways
          // unless it is given something to scroll inside.
          table({ children: content }) {
            return createElement(
              "div",
              { className: "table-scroll" },
              createElement("table", null, content as ReactNode),
            );
          },
          a({ href, title, children: content }) {
            const safe = safeHref(href);

            // A refused scheme renders as plain text. Dropping the content
            // instead would silently delete part of someone's note.
            if (!safe) return createElement("span", null, content as ReactNode);

            const external = /^https?:/i.test(safe);
            // Attributes are listed rather than spread. Spreading would also
            // forward react-markdown's `node`, and it means any attribute a
            // future plugin decides to attach lands on the element without
            // anyone choosing it.
            return createElement(
              "a",
              {
                title,
                href: safe,
                // noreferrer also covers the reverse-tabnabbing that
                // target="_blank" opens up on older engines.
                rel: "noopener noreferrer nofollow",
                target: external ? "_blank" : undefined,
              },
              content as ReactNode,
            );
          },
        },
      },
      children,
    ),
  );
}
