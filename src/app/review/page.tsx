import type { Metadata } from "next";
import Link from "next/link";
import { dueForReview } from "@/lib/fsrs";
import ReviewSession from "@/components/review-session";
import { Page, PageHeader, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Review" };

/**
 * The spaced repetition session.
 *
 * `dueForReview` already does the hard part: it applies the daily caps and
 * reports `totalDue` and `cappedBy` separately, so "nothing to do" and "you
 * have done enough today" can be told apart. Conflating them would make the
 * caps feel like a bug, so this page keeps them apart too.
 */
export default async function ReviewPage() {
  const queue = await dueForReview(20);

  if (queue.cards.length === 0) {
    return (
      <Page width="read">
        <PageHeader
          title={queue.totalDue === 0 ? "Nothing due" : "Done for today"}
          lead={queue.note}
        />
        <Empty>
          {queue.cappedBy === "reviews" ? (
            <p style={{ margin: 0 }}>
              The daily cap exists so a backlog cannot turn into a two hour
              session you abandon halfway. The rest will be waiting tomorrow.
            </p>
          ) : queue.cappedBy === "new" ? (
            <p style={{ margin: 0 }}>
              New cards are limited separately, because introducing fifty at
              once guarantees they all come back on the same day.
            </p>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                Nothing is scheduled. This is a normal state, not an error.
              </p>
              <p style={{ marginBottom: 0 }}>
                Storing and rehearsing are separate here: most of what you save
                is reference material you want to find, not memorise. A concept
                joins this queue when you say <em>&ldquo;and track these&rdquo;</em>{" "}
                while adding it, or when you tick{" "}
                <strong>In spaced repetition</strong> on its page. See{" "}
                <Link href="/hygiene">hygiene</Link> for what is tracked.
              </p>
            </>
          )}
        </Empty>
      </Page>
    );
  }

  return (
    <Page width="read">
      <ReviewSession cards={queue.cards} totalDue={queue.totalDue} />
    </Page>
  );
}
