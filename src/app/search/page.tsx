import Link from "next/link";
import { hybridSearch } from "@/lib/graph";

export const dynamic = "force-dynamic";

/**
 * Search, backed by the same `hybridSearch` the MCP tools use, so the UI and
 * Claude agree on what "finding something" means. Full text catches the
 * jargon you remember; the vector half catches the description you can only
 * paraphrase.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const results = query ? await hybridSearch(query, 25) : [];

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 1rem" }}>
        {query ? (
          <>
            {results.length} {results.length === 1 ? "result" : "results"} for{" "}
            <span style={{ color: "var(--muted)" }}>{query}</span>
          </>
        ) : (
          "Search"
        )}
      </h1>

      {query && results.length === 0 && (
        <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
          Nothing matched. Both halves of the search — exact wording and
          meaning — came back empty, so this is probably not in the graph yet.
        </p>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
        {results.map((r) => (
          <li key={r.id}>
            <Link
              href={`/c/${r.id}`}
              style={{
                display: "block",
                padding: "0.6rem 0.8rem",
                border: "1px solid var(--line)",
                borderRadius: 8,
                color: "var(--fg)",
                textDecoration: "none",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <strong style={{ fontWeight: 600 }}>{r.name}</strong>
                <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
                  {r.sources.join(" + ")}
                </span>
              </div>
              <p
                style={{
                  margin: "0.3rem 0 0",
                  color: "var(--muted)",
                  fontSize: "0.85rem",
                  lineHeight: 1.5,
                }}
              >
                {r.body.slice(0, 220)}
                {r.body.length > 220 && "…"}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
