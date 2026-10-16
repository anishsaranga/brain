/**
 * Downloads the embedding model into the image at BUILD time.
 *
 *   node scripts/bake-model.mjs
 *
 * Runs in the Docker builder stage. Without this the model is fetched on first
 * use, which means a 30s+ first MCP tool call — the one a connector is most
 * likely to give up on — and a container that is simply broken whenever
 * HuggingFace is unreachable. Neither is acceptable for a service whose whole
 * job is to answer quickly from local data.
 *
 * Running one real inference is the download: it pulls exactly the files the
 * runtime will ask for, in the cache layout it will look for them in, so there
 * is no chance of baking a near-miss.
 */
import { pipeline, env } from "@huggingface/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const DIMS = 384;
const dir = process.argv[2] ?? "/app/models";

env.cacheDir = dir;
env.allowRemoteModels = true; // the one place this is intentionally on

console.log(`[bake] downloading ${MODEL} into ${dir}`);
const started = Date.now();

const extractor = await pipeline("feature-extraction", MODEL, { dtype: "fp32" });
const out = await extractor("warm", { pooling: "mean", normalize: true });
const vec = out.tolist()[0];

if (vec.length !== DIMS) {
  console.error(`[bake] FAIL: model returned ${vec.length} dims, expected ${DIMS}`);
  process.exit(1);
}
if (!vec.every(Number.isFinite)) {
  console.error("[bake] FAIL: model returned non-finite values");
  process.exit(1);
}

console.log(`[bake] ok — ${DIMS} dims in ${Date.now() - started}ms`);
