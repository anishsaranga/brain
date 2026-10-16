import { createHash } from "node:crypto";
import { EMBEDDING_DIMS } from "@/lib/schema";

/**
 * Local sentence embeddings. No API key, ever — extraction and judgement are
 * the model's job in the conversation; the server only does bookkeeping.
 *
 * all-MiniLM-L6-v2 produces 384-dim vectors, which is why
 * `EMBEDDING_DIMS` in schema.ts is 384. The two MUST agree: the vector index is
 * created with a fixed dimension and rejects anything else, so the constant is
 * imported from there rather than written twice.
 */

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Bump to force a re-embed of every concept without changing the model, e.g.
 * if the text that feeds the embedding (see `embeddingText`) changes shape.
 * Stored per-node so scripts/reembed.mjs can find stale rows.
 */
export const EMBEDDING_VERSION = 1;

/** Where the model files live inside the image. Baked at build time. */
const MODEL_DIR = process.env.MODEL_DIR ?? "/app/models";

type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

const GLOBAL_KEY = Symbol.for("brain.embeddings.pipeline");
type GlobalWithPipe = typeof globalThis & {
  [GLOBAL_KEY]?: Promise<FeatureExtractor>;
};
const g = globalThis as GlobalWithPipe;

async function getPipeline(): Promise<FeatureExtractor> {
  // Cache the PROMISE, not the resolved pipeline: two concurrent first calls
  // would otherwise both start loading the model, doubling peak memory during
  // boot for no benefit.
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");

      // The model is baked into the image at build time (see
      // scripts/bake-model.mjs). Downloading on first use instead would make
      // the first MCP tool call take 30s+, and would break the container
      // outright whenever HuggingFace is unreachable — an avoidable runtime
      // dependency on someone else's uptime.
      env.cacheDir = MODEL_DIR;
      env.allowRemoteModels = process.env.ALLOW_REMOTE_MODELS === "1";

      return (await pipeline("feature-extraction", EMBEDDING_MODEL, {
        dtype: "fp32",
      })) as unknown as FeatureExtractor;
    })();
  }
  return g[GLOBAL_KEY];
}

function assertShape(vec: number[]): number[] {
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Embedding has ${vec.length} dimensions, expected ${EMBEDDING_DIMS}. ` +
        `The model and the concept_vec index disagree — see EMBEDDING_DIMS.`,
    );
  }
  return vec;
}

/** Embed one string. Returns a unit-length vector. */
export async function embed(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec;
}

/**
 * Embed several strings in one pass.
 *
 * `normalize: true` makes every vector unit length, which matters because the
 * index uses cosine similarity: pre-normalising keeps scores comparable and
 * lets similarity reduce to a dot product.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const out = await pipe(texts, { pooling: "mean", normalize: true });
  return out.tolist().map(assertShape);
}

/**
 * The text a concept is embedded from: what it is called, what else it is
 * called, and what it says. Name first, because it is the strongest signal and
 * the model truncates long inputs.
 */
export function embeddingText(input: {
  name: string;
  aliases?: string[];
  body?: string;
}): string {
  return [input.name, ...(input.aliases ?? []), input.body ?? ""]
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Hash of the embedded text plus the model identity. Stored on the node so an
 * update that does not touch name/aliases/body skips re-embedding — which is
 * what keeps `update_concept` cheap when it is only flipping `tracked`.
 */
export function embeddingHash(text: string): string {
  return createHash("sha256")
    .update(`${EMBEDDING_MODEL}@${EMBEDDING_VERSION}\n${text}`)
    .digest("hex");
}

/**
 * Load the model and run one inference.
 *
 * Called at boot from instrumentation.ts. The first inference initialises the
 * ONNX graph and is far slower than the rest; paying that during startup keeps
 * it out of the first MCP tool call, which is exactly the one a connector is
 * most likely to time out on.
 */
export async function warm(): Promise<{ ms: number; dims: number }> {
  const started = Date.now();
  const vec = await embed("warm");
  return { ms: Date.now() - started, dims: vec.length };
}
