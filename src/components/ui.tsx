import Link from "next/link";
import styles from "./ui.module.css";

/**
 * The handful of shapes every page in the explorer is built from.
 *
 * These exist because the same five style objects were being redeclared in
 * every page file, which is how the app ended up with three slightly
 * different list rows and two different muted greys.
 */

export function Page({
  children,
  width = "normal",
}: {
  children: React.ReactNode;
  /** `wide` is for pages carrying a canvas; `read` is for long prose. */
  width?: "read" | "normal" | "wide";
}) {
  return <main className={`${styles.page} ${styles[width]}`}>{children}</main>;
}

export function PageHeader({
  title,
  lead,
  aside,
}: {
  title: React.ReactNode;
  lead?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeaderMain}>
        <h1 className={styles.pageTitle}>{title}</h1>
        {lead && <p className={styles.lead}>{lead}</p>}
      </div>
      {aside && <div className={styles.pageHeaderAside}>{aside}</div>}
    </header>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A list that fades its children in, in order.
 *
 * The index is passed down as a custom property rather than an inline
 * animation-delay so the whole effect stays in the stylesheet, where the
 * reduced-motion query can switch it off.
 */
export function List({
  children,
  className,
}: {
  children: React.ReactNode[];
  className?: string;
}) {
  return (
    <ul className={`${styles.list} stagger ${className ?? ""}`}>
      {children.map((child, i) => (
        <li key={i} style={{ "--i": Math.min(i, 14) } as React.CSSProperties}>
          {child}
        </li>
      ))}
    </ul>
  );
}

/** The standard tappable row: a label, and something quiet on the right. */
export function RowLink({
  href,
  children,
  meta,
  tone,
}: {
  href: string;
  children: React.ReactNode;
  meta?: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <Link
      href={href}
      className={`${styles.row} ${styles.rowLink} ${tone ? styles[tone] : ""}`}
    >
      <span className={styles.rowLabel}>{children}</span>
      {meta && <span className={styles.rowMeta}>{meta}</span>}
    </Link>
  );
}

export function Row({
  children,
  meta,
  tone,
}: {
  children: React.ReactNode;
  meta?: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div className={`${styles.row} ${tone ? styles[tone] : ""}`}>
      <span className={styles.rowLabel}>{children}</span>
      {meta && <span className={styles.rowMeta}>{meta}</span>}
    </div>
  );
}

export function Stat({
  label,
  value,
  href,
  tone,
  title,
}: {
  label: string;
  value: number | string;
  href?: string;
  tone?: "accent" | "danger";
  title?: string;
}) {
  const body = (
    <>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </>
  );
  const className = `${styles.stat} ${tone ? styles[tone] : ""}`;
  return href ? (
    <Link href={href} className={`${className} ${styles.statLink}`} title={title}>
      {body}
    </Link>
  ) : (
    <div className={className} title={title}>
      {body}
    </div>
  );
}

export function Stats({ children }: { children: React.ReactNode }) {
  return <div className={`${styles.stats} stagger`}>{children}</div>;
}

/** Small state markers: tracked, flagged, undone. Never decorative. */
export function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "accent" | "danger" | "quiet";
}) {
  return <span className={`${styles.tag} ${styles[tone ?? "quiet"]}`}>{children}</span>;
}

/**
 * An empty state says what to do next, not just that there is nothing here.
 * Several of these states are the healthy one (an empty inbox, nothing due),
 * so the copy must not read as a failure.
 */
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function Note({ children }: { children: React.ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

/** The quiet second line inside a row: a snippet, a flag note, a reason. */
export function Sub({ children }: { children: React.ReactNode }) {
  return <span className={styles.sub}>{children}</span>;
}

/** Monospaced inline datum: an id, a count, a timestamp, a score. */
export function Datum({ children }: { children: React.ReactNode }) {
  return <span className={styles.datum}>{children}</span>;
}

/**
 * A date, rendered server-side as a fixed ISO day.
 *
 * Deliberately not relative ("3 days ago"): the server and the browser would
 * disagree about "now" and React would warn about the mismatch on every
 * single row.
 */
export function When({ iso }: { iso?: string | null }) {
  if (!iso) return <span className={styles.datum}>never</span>;
  return (
    <time className={styles.datum} dateTime={iso}>
      {iso.slice(0, 10)}
    </time>
  );
}
