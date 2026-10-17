/**
 * The relationship vocabulary, and nothing else.
 *
 * Separate from `graph.ts` because the explorer's client components need these
 * names, and importing them from `graph.ts` would pull `neo4j-driver` into the
 * browser bundle. A file of constants with no imports can be shared by both
 * sides without that.
 *
 * A closed vocabulary is the single most load-bearing constraint on a graph
 * fed by a language model across hundreds of independent conversations: make
 * the invalid value unrepresentable. Without it you get RELATES_TO /
 * RELATED_TO / IS_RELATED_TO and a graph nothing can query.
 */
export const REL_TYPES = [
  "PREREQUISITE_OF",
  "RELATED_TO",
  "EXAMPLE_OF",
  "CONTRASTS_WITH",
  "PART_OF",
  "CITES",
] as const;

export type RelType = (typeof REL_TYPES)[number];

/** Types that read the same in both directions; the UI draws them unarrowed. */
export const UNDIRECTED: ReadonlySet<RelType> = new Set<RelType>([
  "RELATED_TO",
  "CONTRASTS_WITH",
]);

export function isRelType(value: string): value is RelType {
  return (REL_TYPES as readonly string[]).includes(value);
}

/** "PREREQUISITE_OF" -> "prerequisite of" */
export function relLabel(type: string): string {
  return type.replace(/_/g, " ").toLowerCase();
}
