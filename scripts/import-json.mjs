/**
 * Restore the graph from a JSON export.
 *
 *   node --import ./scripts/alias-hook.mjs scripts/import-json.mjs <file>
 *   npm run import:json -- backups/brain-2026-10-16.json
 *
 * Idempotent: running it twice over the same file leaves the same graph.
 * Properties are written verbatim, so ids and FSRS review state survive —
 * see src/lib/restore.ts for why that cannot go through upsertConcept.
 *
 * Does NOT clear the database first. Restoring into a non-empty graph merges;
 * pass --wipe to replace, which asks for confirmation unless --yes is given.
 */
import fs from "node:fs";
import readline from "node:readline/promises";

const file = process.argv.find((a) => a.endsWith(".json") && !a.startsWith("--"));
const wipe = process.argv.includes("--wipe");
const assumeYes = process.argv.includes("--yes");

if (!file) {
  console.error("Usage: npm run import:json -- <file.json> [--wipe] [--yes]");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(
  `[import] ${file}\n` +
    `         exported ${data.exportedAt} from Neo4j ${data.neo4j}\n` +
    `         ${JSON.stringify(data.counts)}\n` +
    `         embeddings ${data.embeddingsIncluded ? "included" : "excluded (will be recomputed)"}`,
);

const { getDriver, write } = await import("@/lib/neo4j");
const { restoreGraph } = await import("@/lib/restore");

if (wipe) {
  if (!assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      "--wipe will DELETE every node in the target database first. Type 'wipe' to continue: ",
    );
    rl.close();
    if (answer.trim() !== "wipe") {
      console.error("[import] aborted");
      process.exit(1);
    }
  }
  await write("MATCH (n) DETACH DELETE n");
  console.log("[import] database cleared");
}

const started = Date.now();
const result = await restoreGraph(data);

console.log(
  `[import] restored ${JSON.stringify(result.nodes)}, ${result.edges} edge(s), ` +
    `re-embedded ${result.reEmbedded} in ${Date.now() - started}ms`,
);
if (result.skippedEdges > 0) {
  console.error(
    `[import] WARNING: ${result.skippedEdges} edge(s) skipped — their endpoints ` +
      `were not in the file. The restore is incomplete.`,
  );
}

await getDriver().close();
process.exit(result.skippedEdges > 0 ? 1 : 0);
