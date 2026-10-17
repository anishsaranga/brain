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
 * misconfiguration away from stored XSS.
 *
 * This builds a React element tree instead. It never sets inner HTML, and it
 * DROPS embedded HTML unless `rehype-raw` is added.
 *
 * NEVER ADD `rehype-raw`. It exists to turn the HTML in a markdown document
 * back into live nodes, which is precisely the property being relied on here.
 *
 * A server component by default, so none of the parser reaches the browser on
 * a read. The editor's preview imports it into a client component and does
 * pay for it, which is a fair trade for one authenticated user.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // The library sanitises URLs by default. This states the policy
        // explicitly rather than inheriting it, so that a dependency bump
        // loosening the default cannot quietly widen what is accepted.
        urlTransform={(url) => safeHref(url) ?? ""}
        components={{
          a({ href, children: content, ...rest }) {
            const safe = safeHref(href);
            // A refused scheme renders as text. Dropping the content instead
            // would silently delete part of someone's note.
            if (!safe) return <span>{content}</span>;

            const external = /^https?:/i.test(safe);
            return (
              <a
                {...rest}
                href={safe}
                // noreferrer also covers the reverse-tabnabbing that target
                // _blank opens up on older engines.
                rel="noopener noreferrer nofollow"
                target={external ? "_blank" : undefined}
              >
                {content}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
