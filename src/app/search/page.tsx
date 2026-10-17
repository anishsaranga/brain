import type { Metadata } from "next";
import { hybridSearch } from "@/lib/graph";
import { excerpt } from "@/lib/markdown";
import { Page, PageHeader, List, RowLink, Empty, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Search" };

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
    <Page>
      <PageHeader
        title={query ? `“${query}”` : "Search"}
        lead={
          query
            ? `${results.length} ${results.length === 1 ? "result" : "results"}`
            : "Matches on wording and on meaning, so a half-remembered description works."
        }
      />

      {query && results.length === 0 && (
        <Empty>
          Nothing matched. Both halves of the search came back empty, the exact
          wording and the meaning, so this is probably not in the graph yet.
        </Empty>
      )}

      <List>
        {results.map((r) => (
          <RowLink
            key={r.id}
            href={`/c/${r.id}`}
            meta={
              <>
                {r.sources.map((s) => (
                  <Tag key={s}>{s}</Tag>
                ))}
              </>
            }
          >
            <span>{r.name}</span>
            {/*
              Flattened, not rendered. A 200-character slice of markdown is a
              broken fragment of a document, and the raw source shows "##" and
              "**" as literal characters.
            */}
            {r.body && (
              <span
                style={{
                  display: "block",
                  color: "var(--muted)",
                  fontWeight: 400,
                  fontSize: "var(--step--1)",
                  lineHeight: 1.55,
                  marginTop: "0.2rem",
                }}
              >
                {excerpt(r.body, 200)}
              </span>
            )}
          </RowLink>
        ))}
      </List>
    </Page>
  );
}
