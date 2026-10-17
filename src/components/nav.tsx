import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { navCounts } from "@/lib/graph";
import ThemeToggle from "./theme-toggle";
import styles from "./nav.module.css";

/**
 * The nav only renders for a signed-in user, which keeps it off the login
 * page without the login page needing a layout of its own.
 *
 * The counts are not decoration. Inbox, due and hygiene are all backlogs that
 * grow silently: captures sit unextracted, tracked cards fall behind, and
 * orphans accumulate because each conversation is blind to the others. A
 * number you walk past every time is the cheapest possible nag.
 */
export default async function Nav() {
  const session = await auth();
  if (!session?.user) return null;

  // A failure here must not take the whole page down. The nav is chrome; if
  // the database is briefly unreachable the page below may still render
  // something useful, and a nav without badges is better than a 500.
  let counts = { inbox: 0, due: 0, orphans: 0, flagged: 0, trash: 0 };
  try {
    counts = await navCounts();
  } catch {
    // Fall through with zeroes.
  }

  const hygiene = counts.orphans + counts.flagged;

  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          brain
        </Link>

        <nav className={styles.links} aria-label="Sections">
          <Item href="/graph" label="Graph" />
          <Item href="/inbox" label="Inbox" count={counts.inbox} />
          <Item href="/review" label="Review" count={counts.due} />
          <Item href="/ingest" label="Ingested" />
          <Item href="/hygiene" label="Hygiene" count={hygiene} />
          <Item href="/trash" label="Trash" />
        </nav>

        <form action="/search" className={styles.search} role="search">
          <input
            name="q"
            type="search"
            placeholder="Search"
            aria-label="Search your knowledge"
            className={styles.input}
          />
        </form>

        <ThemeToggle />

        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button type="submit" className={styles.signout}>
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

/**
 * A count of zero renders no badge at all rather than a grey "0". An empty
 * inbox should look calm, not like a metric you are failing.
 */
function Item({ href, label, count }: { href: string; label: string; count?: number }) {
  return (
    <Link href={href} className={styles.link}>
      {label}
      {count !== undefined && count > 0 && <span className={styles.count}>{count}</span>}
    </Link>
  );
}
