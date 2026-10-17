import Link from "next/link";
import { conceptsInTopic } from "@/lib/graph";

export const dynamic = "force-dynamic";

export default async function TopicPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const topic = decodeURIComponent(name);
  const concepts = await conceptsInTopic(topic);

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1 style={{ fontSize: "1.3rem", margin: "0 0 0.25rem" }}>{topic}</h1>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", margin: "0 0 1.25rem" }}>
        {concepts.length} {concepts.length === 1 ? "concept" : "concepts"}
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}>
        {concepts.map((c) => (
          <li key={c.id}>
            <Link
              href={`/c/${c.id}`}
              style={{
                display: "block",
                padding: "0.55rem 0.8rem",
                border: "1px solid var(--line)",
                borderRadius: 8,
                color: "var(--fg)",
                textDecoration: "none",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <span>{c.name}</span>
                {c.tracked && (
                  <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>in review</span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
