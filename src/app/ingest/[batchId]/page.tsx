import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getIngestBatch } from "@/lib/graph";
import { relLabel } from "@/lib/rel-types";
import { excerpt } from "@/lib/markdown";
import UndoBatch from "@/components/undo-batch";
import { Page, PageHeader, Section, Stats, Stat, List, Empty, Tag, Datum } from "@/components/ui";
import styles from "./batch.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ingest batch" };

/**
 * What one `remember` call did, and how to take it back.
 *
 * This is the page `remember` has been linking to since the first ingest.
 * Its `reviewUrl` is `<base>/ingest/<batchId>`, returned on every successful
 * call, and the route did not exist: the system was handing out a dead link
 * on its single most used path. Everything shown here was already being
 * written to the :Ingest node. It just had no reader.
 */
export default async function BatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const batch = await getIngestBatch(batchId);
  if (!batch) notFound();

  const liveLinks = batch.links.filter((l) => l.present).length;

  return (
    <Page>
      <PageHeader
        title="Ingest batch"
        lead={
          <>
            Written {batch.at.slice(0, 10)} at {batch.at.slice(11, 16)}
            {batch.toolCaller && <> by {batch.toolCaller}</>}.{" "}
            <Datum>{batch.id}</Datum>
          </>
        }
        aside={
          batch.undone ? (
            <Tag tone="danger">undone</Tag>
          ) : (
            <UndoBatch batchId={batch.id} />
          )
        }
      />

      {batch.undone && (
        <div className={styles.undone}>
          This batch was reversed{batch.undoneAt ? ` on ${batch.undoneAt.slice(0, 10)}` : ""}.
          The concepts it created are in the trash rather than destroyed, and the
          bodies it merged into were put back, so the undo is itself reversible.
        </div>
      )}

      <Stats>
        <Stat label="created" value={batch.created} />
        <Stat label="merged" value={batch.merged} />
        <Stat label="links" value={liveLinks} />
      </Stats>

      {batch.createdConcepts.length > 0 && (
        <Section title="Created">
          <List>
            {batch.createdConcepts.map((c) => (
              <ConceptRow key={c.id} concept={c} />
            ))}
          </List>
        </Section>
      )}

      {batch.mergedConcepts.length > 0 && (
        <Section title="Merged into">
          <p className={styles.hint}>
            These already existed. A merge appends, so what an earlier
            conversation wrote is still there above the new material.
          </p>
          <List>
            {batch.mergedConcepts.map((c) => (
              <ConceptRow key={c.id} concept={c} />
            ))}
          </List>
        </Section>
      )}

      <Section title="Links">
        {batch.links.length === 0 ? (
          <Empty>
            This batch wrote no links. Concepts that arrive unconnected are the
            main way the graph turns into a pile of per-conversation islands,
            so each of the above is worth opening and stitching in.
          </Empty>
        ) : (
          <List>
            {batch.links.map((l) => (
              <div
                key={`${l.from}-${l.to}-${l.type}`}
                className={`${styles.link} ${l.present ? "" : styles.gone}`}
              >
                <span className={styles.linkBody}>
                  <Link href={`/c/${l.from}`} className={styles.linkName}>
                    {l.fromName}
                  </Link>
                  <span className={styles.rel}>{relLabel(l.type)}</span>
                  <Link href={`/c/${l.to}`} className={styles.linkName}>
                    {l.toName}
                  </Link>
                </span>
                {!l.present && <Tag>removed</Tag>}
              </div>
            ))}
          </List>
        )}
      </Section>
    </Page>
  );
}

function ConceptRow({
  concept,
}: {
  concept: { id: string; name: string; body: string; deleted: boolean };
}) {
  // A destroyed concept has no page left to open.
  const inner = (
    <>
      <span className={styles.conceptName}>{concept.name}</span>
      {concept.body && <span className={styles.snippet}>{excerpt(concept.body, 150)}</span>}
    </>
  );

  if (concept.name === "(destroyed)") {
    return (
      <div className={styles.concept}>
        <span className={styles.conceptBody}>{inner}</span>
        <Tag tone="danger">destroyed</Tag>
      </div>
    );
  }

  return (
    <Link href={`/c/${concept.id}`} className={`${styles.concept} ${styles.clickable}`}>
      <span className={styles.conceptBody}>{inner}</span>
      {concept.deleted && <Tag tone="danger">in trash</Tag>}
    </Link>
  );
}
