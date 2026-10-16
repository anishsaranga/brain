/**
 * Resolves the `@/…` path alias for plain `node` runs.
 *
 * Most content files import types only, which Node's type-stripping erases, so
 * they load with no help. Anything with a *value* import of `@/…` (the
 * registry, the validator) needs this:
 *
 *   node --import ./scripts/alias-hook.mjs scripts/whatever.mjs
 *
 * It also stubs the bare specifier `server-only` to an empty module. That
 * package exists to make a *bundler* fail when a client component imports a
 * server module; under plain node there is no client bundle to protect, and the
 * real package throws on import, so scripts that exercise server modules
 * (e.g. the progress db check) would otherwise be unable to load them.
 *
 * A few lines instead of a dependency, and it keeps the scripts buildless.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), "../src");

export function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: "data:text/javascript,export {}", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const base = resolvePath(SRC, specifier.slice(2));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
      if (existsSync(candidate) && !candidate.endsWith("/")) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

register(import.meta.url, { parentURL: import.meta.url });
