export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: 0 }}>brain</h1>
      <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
        Knowledge graph service is running. The explorer and review session are
        not built yet — this is the milestone&nbsp;1 skeleton.
      </p>
      <p style={{ color: "var(--muted)" }}>
        <a href="/api/health" style={{ color: "inherit" }}>
          /api/health
        </a>
      </p>
    </main>
  );
}
