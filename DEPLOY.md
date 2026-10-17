# Deploying `brain` on the homelab

> **Placeholders.** `<HOSTNAME>`, `<TUNNEL_ID>`, `<ZONE>`, `<TAILSCALE_IP>`,
> `<HOST>` and `<ONEDRIVE_BACKUP_DIR>` are filled in by `DEPLOY.local.md`, which
> is gitignored. This repo is public, and the real values map a specific
> machine — the tunnel id in particular is shared by every service on that box,
> not just this one. Nothing in them is a credential; they are simply nobody
> else's business.

A knowledge graph fed from Claude conversations over MCP, with a graph explorer
and an FSRS review session on top. Same pattern as the other services on
`<HOST>` — see `C:\SERVER_REPOS\SERVICES-RUNBOOK.md` for the
Cloudflare Tunnel / Tailscale / Docker-Desktop topology and reboot-recovery
notes.

| Public route                    | Local target            | Backing service                       |
|---------------------------------|-------------------------|---------------------------------------|
| `<HOSTNAME>` (host) | `http://localhost:9999` | `brain-web` + `brain-neo4j` (compose) |

Ports in use elsewhere on this box: 1111, 4444, 5555, 6060, 7777, 8080, 5432,
5433. `brain` uses **9999** (web), **7474** and **7687** (Neo4j, loopback only).

Unlike `learn` and `gallery`, this one is a **subdomain, not a path**. That
avoids the Next.js `basePath` workarounds `learn/middleware.ts` documents at
length, and leaves `/.well-known/*` at the origin root for the OAuth metadata
that stage-2 connector auth will need.

## Two things that will bite you

1. **Neo4j Browser (7474) must never be routed through the tunnel.** It is a
   full write console, and Community Edition has no meaningful access control
   (RBAC is Enterprise-only; there is a single user). It is bound to loopback —
   reach it over Tailscale at `http://<TAILSCALE_IP>:7474`.
2. **`docker compose down -v` deletes the graph.** The `brain-neo4j-data` volume
   *is* the knowledge base, and unlike every other service on this box it cannot
   be rebuilt from a repo. Plain `docker compose down` is safe. Never pass `-v`
   unless you mean it.

## 1. Configure secrets

```powershell
cd C:\SERVER_REPOS\brain
Copy-Item .env.example .env
# Fill in NEO4J_PASSWORD (openssl rand -hex 20)
```

`openssl` is not on PATH in a stock PowerShell here (Git ships one at
`C:\Program Files\Git\usr\bin\openssl.exe` if you want it). For the two
MCP secrets use the script instead, which generates them with a CSPRNG,
writes them straight into `.env`, and never prints them — a secret you have
pasted through a terminal is one you can no longer account for:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotate-mcp-secrets.ps1
```

`-ExecutionPolicy Bypass` is not window dressing: a default Windows box
refuses to run an unsigned local `.ps1` at all, with a SecurityError that
reads like a permissions problem. It applies to that one process only, so
prefer it over `Set-ExecutionPolicy`, which is a persistent machine-wide
change made in order to run a script you wrote yourself. `-NoProfile` stops
your shell profile from altering what the script sees. **Every script in
`scripts/` needs both flags when run by hand.** The scheduled tasks already
pass them, which is why the nightly export has always worked while the
hand-typed commands in this file did not.

**`NEO4J_AUTH` only applies on the first boot of an empty data volume.** Editing
`NEO4J_PASSWORD` in `.env` later changes nothing — the password is already baked
into the volume — and produces a confusing auth failure. To rotate it, use
`ALTER CURRENT USER SET PASSWORD` in cypher-shell.

The compose file also passes the password to the Neo4j container a second time
as `BRAIN_NEO4J_PASSWORD`, purely so the healthcheck can run `cypher-shell`. It
is **deliberately not** `NEO4J_`-prefixed: that image parses every `NEO4J_*`
variable as a server config setting and refuses to start, with
`Unrecognized setting: PASSWORD`.

## 2. Build and run

```powershell
cd C:\SERVER_REPOS\brain
docker compose up -d --build
```

`brain-web` waits for `brain-neo4j` to pass a real `RETURN 1` healthcheck before
starting — Bolt takes 20-40s to open — and the app additionally retries on its
own, because this box's documented failure mode is an unattended reboot where
the whole stack cold-starts at once.

Verify locally:

```bash
curl -s http://127.0.0.1:9999/api/health
```

`/api/health` returns **503 when Neo4j is unreachable**. A web container
answering 200 while the graph is down would be worse than one admitting it.

### Resource footprint

`brain` is the largest service on this box, because the embedding model runs
in-process. Measured, not estimated:

| | |
|---|---|
| `brain-web` image | 636 MB |
| `brain-web` RSS (model loaded) | ~264 MB, capped at 1 GB |
| `brain-neo4j` RSS | ~950 MB (heap 1 GB + pagecache 512 MB) |
| Cold start to healthy | ~28 s (healthcheck `start_period` is 40 s) |

`mem_limit` equals `memswap_limit`, so a leak is OOM-killed and restarted
rather than swapping and dragging the other nine containers down — the same
reasoning `bathroom-status` documents.

Two Dockerfile details worth not undoing:

- The ONNX runtime is pruned in **its own stage**. A `COPY` followed by a
  `RUN rm` in the runner leaves the deleted files in the earlier layer: present
  in the image, invisible in the filesystem, and paid for on every pull. Doing
  it this way took the image from 1.48 GB to 636 MB.
- `onnxruntime-node` and `onnxruntime-common` are copied **wholesale** rather
  than traced. transformers.js reaches them through a runtime `require` that
  Next's standalone tracer cannot follow, so it copies fragments — enough that
  the container starts and then dies on first inference.

## Checks

```bash
docker compose -f docker-compose.test.yml up -d
npm run graph:check
docker compose -f docker-compose.test.yml down
```

29 behavioural checks over the graph layer: upsert/merge semantics, the closed
relationship vocabulary, bounded neighbourhoods, embeddings, and hybrid search.
Exits 1 on any failure.

They run **in Linux, against a throwaway Neo4j on 7688** — not on the Windows
host and never against the production graph:

- onnxruntime-node's win32 binding fails to `dlopen` on this machine (a missing
  dependent DLL), so embeddings cannot run on the host at all. Running the
  checks in a container also means they exercise the same binaries production
  does.
- Community Edition has a single database, so test isolation needs a separate
  *server*, not a separate database.
- The script holds an **allowlist** of permitted targets and refuses anything
  else. Its first action is `DETACH DELETE` on every node, and the production
  graph is the one thing here that cannot be rebuilt from a repo.

## 3. DNS — point the subdomain at the tunnel

```powershell
cloudflared tunnel route dns <TUNNEL_ID> <HOSTNAME>
```

Equivalent to adding a proxied `CNAME brain` pointing at
`<TUNNEL_ID>.cfargotunnel.com` in the dashboard.

## 4. Tunnel ingress

Edit **`C:\ProgramData\Cloudflared\config.yml`** — the ProgramData copy is the
one the Windows service reads; the copy under `C:\Users\anish\.cloudflared\` is
stale and unused. Add this **above** the final `http_status:404` catch-all:

```yaml
  # brain - knowledge graph + MCP connector (docker compose, port 9999)
  - hostname: <HOSTNAME>
    service: http://localhost:9999
```

Then, elevated:

```powershell
Restart-Service Cloudflared
```

This briefly interrupts every public route on the box, so do it deliberately.

## 5. WAF rule — stage-1 auth for the MCP endpoint

**This lives in the Cloudflare dashboard, not in this repo.** Without this note
it will be a mystery in six months.

Security → WAF → Custom rules → Create rule, on zone `<ZONE>`:

- **Name**: `brain-mcp-anthropic-only`
- **Expression**:

```
(http.host eq "<HOSTNAME>"
 and starts_with(http.request.uri.path, "/mcp")
 and not ip.src in {160.79.104.0/21})
```

- **Action**: Block

`160.79.104.0/21` is Anthropic's published egress range for connector traffic.

Match `/mcp` **specifically** — a broader pattern would later also catch
`/.well-known/oauth-protected-resource` and silently break stage-2 OAuth
discovery.

Combined with the secret path segment, reaching the MCP endpoint requires being
inside Anthropic's egress range *and* guessing the path.

## 6. Add the connector in Claude

claude.ai → Settings → Connectors → **Add custom connector**, URL:

```
https://<HOSTNAME>/mcp/<MCP_PATH_SECRET>
```

Auth type is `none` (authless), which Anthropic supports by default for custom
connectors. Then, in any conversation, call `ping` to confirm.

### The bearer token

The path secret alone works, but a secret in a URL ends up in request logs,
browser history and any screenshot of this dialog. The same credential in a
header does not, so `MCP_BEARER_TOKEN` is the real one and the path segment
stays underneath it as a second factor.

In the same dialog, under **Request headers**, add either:

```
Authorization: Bearer <MCP_BEARER_TOKEN>
X-Brain-Token: <MCP_BEARER_TOKEN>
```

The server accepts both names. That is deliberate: "Request headers" is a
limited beta, and whether the platform passes a custom `Authorization` through
or reserves that name for its own OAuth flow cannot be determined from the
server side. If one turns out to be stripped, switch to the other here — no
redeploy.

**Roll it out in two steps, because getting this wrong produces a 404 that is
indistinguishable from a broken tunnel:**

1. **Permissive.** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotate-mcp-secrets.ps1`, then
   recreate `brain-web`. It leaves `MCP_REQUIRE_TOKEN` unset, so the token
   is compared and reported but not required, and nothing you mistype in
   the dialog can break anything. **Rotating the path secret changes the
   connector URL**, so the existing connector stays broken until step 2 —
   that is expected, not a fault to debug.
2. Add the header, call `ping`, then load `https://<HOSTNAME>/api/health`
   **while logged in** and read `mcpAuth.lastAttempt`:

   ```json
   { "sawAuthorizationHeader": true, "sawCustomHeader": false,
     "tokenPresented": true, "tokenMatched": true, "outcome": "ok (token)" }
   ```

   `sawAuthorizationHeader: false` means the platform did not pass it — switch
   the connector to `X-Brain-Token` and repeat. `tokenMatched: false` with
   `tokenPresented: true` is a copy-paste error in the value.
3. **Enforcing.** Only once step 2 is green: set `MCP_REQUIRE_TOKEN=1`,
   recreate, and `ping` once more. A request without a valid token is now a
   404 — same as every other refusal, because a distinguishable response would
   confirm that something lives under `/mcp`.

### Also add it to Claude Code on this box

Fastest dev loop — no tunnel, no WAF in the way:

```bash
claude mcp add --transport http brain http://localhost:9999/mcp/<MCP_PATH_SECRET>
```

Worth keeping permanently rather than only for development: it means knowledge
from coding sessions lands in the same graph.

## Debug ladder — "Couldn't reach the MCP server"

Ordered by how often each turns out to be the answer.

1. **MCP Inspector, locally**:
   `npx @modelcontextprotocol/inspector http://127.0.0.1:9999/mcp/<secret>`.
   If this fails, the problem is the app, not the network.
2. **Raw handshake, locally** — a POST of
   `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}` with
   `Content-Type: application/json` and
   `Accept: application/json, text/event-stream`. A `404` means the secret
   segment does not match `MCP_PATH_SECRET`.
3. **Through the tunnel** — the same request against
   `https://<HOSTNAME>`. A `403` is the WAF rule **working** (you
   are not Anthropic). To prove the path end to end, temporarily disable the
   rule, retest, then re-enable it.
4. **Check the CIDR for a typo.** A wrong egress range blocks Claude itself and
   looks identical to the server being down.
5. **`Get-Service Cloudflared`** and its logs. If local checks pass and public
   ones fail, the problem is the tunnel, not the containers.
6. **A 404 that is really the token.** Once `MCP_REQUIRE_TOKEN=1`, a missing,
   stripped or mistyped header looks exactly like a wrong path secret, by
   design. Do not guess — load `/api/health` authenticated and read
   `mcpAuth`. It gives the mode, whether a token is configured at all, and
   which headers the last request actually carried. `mode: "enforcing"` with
   `tokenConfigured: false` means `MCP_REQUIRE_TOKEN` is set but
   `MCP_BEARER_TOKEN` is not: it fails closed, so everything 404s.

## Data and backups

The graph is **the only irreplaceable thing on this box**. Every other service
here is reconstructible from a repo; this one *is* the asset.

A constraint that shapes everything: `neo4j-admin database dump` **requires the
database to be offline** — it says so in its own help text — and online backup
(`neo4j-admin database backup`) is Enterprise-only. On Community every dump
costs downtime, which inverts the usual ordering and makes the portable text
export the primary rather than the fallback.

| Tier | What | When | Downtime |
|---|---|---|---|
| 1 | JSON export (`npm run export:json`) | nightly | none |
| 2 | markdown export (`npm run export:md`) | nightly | none |
| 3 | `neo4j-admin` dump (`scripts/dump.ps1`) | monthly | ~30 s |

Tier 1 is the one that matters. It is version-independent, human-readable, and
restorable into any graph store including a future non-Neo4j one. Tier 3 is
byte-exact and faster to restore but only this Neo4j version can read it.

**Embeddings are excluded** from the export. They are derived data — a restore
recomputes them locally in seconds — and including them roughly quintuples the
file. `--with-embeddings` exists for a byte-fidelity copy.

Only the `neo4j` database is dumped, not `system`: on Community `system` holds
little beyond the single user's password, and restoring a stale one is a
confusing failure rather than a useful recovery.

### Where backups go

- `./backups` locally — dated `brain-YYYY-MM-DD.json`, `.md.d/` and `.dump`.
- **Text exports also mirror to `<ONEDRIVE_BACKUP_DIR>`**, so
  they leave this disk with no extra tooling and get OneDrive's own version
  history. Dumps stay local: large, binary, and only readable by this exact
  Neo4j version. Set `BACKUP_MIRROR_DIR=""` to turn the mirror off.
- Rotation keeps **14 daily + 12 monthly** text exports and **3** dumps.
  Pruning only ever deletes files matching the scripts' own naming pattern — a
  pruner that can delete something it did not write is its own disaster.

### Restore

```bash
npm run import:json -- backups/brain-2026-10-16.json          # merge
npm run import:json -- backups/brain-2026-10-16.json --wipe   # replace (prompts)
```

Idempotent — running it twice leaves the same graph. Properties are written
**verbatim**, which is the whole reason `src/lib/restore.ts` exists rather than
reusing `upsertConcept`: that mints a fresh id and resets the FSRS fields
`ON CREATE`, so restoring through it would appear to succeed while assigning
new ids (breaking every edge) and wiping every review schedule.

To restore a tier-3 dump instead, stop the container and
`neo4j-admin database load neo4j --from-path=/backups --overwrite-destination`.

### The restore is rehearsed on every check run

```bash
docker compose -f docker-compose.test.yml up -d
npm run backup:check
```

23 checks that build a fixture graph covering every label and relationship
type, export it, **delete everything**, import, and assert the result is
identical — ids, FSRS state, datetimes-as-datetimes, unicode bodies, edge
properties, and embeddings regenerated so semantic search still works. "An
untested backup is not a backup", made continuous rather than a one-off
rehearsal nobody repeats.

It also asserts the two refusals that keep a backup honest: an **unknown node
label** and a **multi-label node** both fail the export loudly rather than
being silently omitted. When a later milestone adds a label, the backup stops
working until someone teaches it about the new data — a ten-second fix, versus
discovering six months of missing nodes at the moment you need them.

### Knowing it still works

`/api/health` reports backup freshness:

```json
"backup": { "lastExport": "brain-2026-10-16.json", "ageHours": 0,
            "stale": false, "count": 1, "lastRun": { "ok": true, "at": "…" } }
```

`stale` goes true past 48 hours. Age comes from the file's **mtime**, not its
name — a file named for today that was written a week ago is exactly the case
worth catching. Each script also writes `last-run-*.json`, so a run that
*failed* is distinguishable from one that never happened.

A stale backup does **not** make `/api/health` return 503. It is something to
act on, not a reason for Docker to start restarting a working service.

### Scheduling

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-backup-tasks.ps1
```

Registers `\brain\brain-export-json` (nightly 04:00) and `\brain\brain-dump`
(every 4 weeks, Sunday 04:30), both as the current user, no elevation. Remove
with `-Unregister`; change times with `-NightlyAt` / `-MonthlyAt`.

They run **only when logged on**, which is an acknowledgement rather than a
limitation: Docker Desktop here is a GUI app that only starts on an interactive
login, so a task firing at the lock screen would find no engine anyway. The
scripts detect that case and log it in one clear line instead of a stack trace,
and the staleness indicator surfaces a run of missed nights.

### Known behaviour during a dump

Stopping Neo4j fails `brain-web`'s healthcheck, so it goes **unhealthy for
~20 seconds** during every monthly dump and then recovers on its own once the
driver reconnects. `scripts/dump.ps1` waits for *both* containers to return to
healthy before reporting success — a monthly task that declared victory while
the user-facing tier was still down would hide a real outage on the one night
nobody is watching.

The stop/dump/restart is wrapped so the restart happens **unconditionally**: a
failed dump is recoverable, a knowledge base left offline because a script
threw is not. Both paths are exercised — the failure case writes a run record
and exits 1.

### Other traps

- `docker compose down -v` destroys the volume — same trap `learn` and
  `bathroom-status` document. Plain `down` is safe.
- Backups land on the same disk as the data; the OneDrive mirror is what covers
  losing the drive. Dumps are not mirrored.

*(The backup scripts land in milestone 3. Until then there is nothing
irreplaceable in the volume.)*

## Status

**Milestone 1 — walking skeleton.** Done. Both containers healthy, schema
applied, MCP `ping` answering over Streamable HTTP, secret-path guard returning
404 on a wrong segment.

**Milestone 2 — graph core.** Done. Local embeddings (all-MiniLM-L6-v2, 384-dim,
baked into the image, warmed at boot in ~0.4 s), the graph read/write API, and
hybrid search fusing full-text and vector results by weighted reciprocal rank.
29 checks passing. No user-facing surface yet — `src/lib/graph.ts` is what the
MCP tools, the explorer and the review session will all sit on.

**Milestone 3 — backups.** Done. Three tiers (nightly JSON + markdown,
monthly dump), mirrored off-box to OneDrive, with the restore rehearsed by 23
round-trip checks on every run and freshness reported by /api/health. The one
remaining manual step is registering the scheduled tasks.

**Milestone 4 — MCP tools + auth.** Done. Thirteen tools and two prompts, a
single-admin auth gate on the web app, soft delete, undoable batches, and 46
checks covering the security refusals as well as the behaviour.

Remaining: the explorer (milestone 5), the review session (6), hygiene
surfaces (7), then OAuth DCR.

Publicly exposed and live: the WAF rule, DNS, tunnel ingress, the claude.ai
connector, the runbook row and the backup scheduled tasks are all in place, and
`ping` from claude.ai has returned real data end to end. `DEPLOY.local.md`
(gitignored) has the real values for each.

What remains on the auth side is finishing the bearer-token rollout — see
"The bearer token" above — and then OAuth DCR.

## The MCP tool surface

Thirteen tools and two prompts, at `/mcp/<MCP_PATH_SECRET>`. The design
constraint throughout is that this is **write access to the knowledge base,
driven by a language model, over a public endpoint** — and that content
ingested today is read back into other conversations weeks later, which is
indirect prompt injection by construction.

**No tool reachable over MCP is irreversible:**

| Operation | Reversible by |
|---|---|
| create / merge | `undo_ingest(batchId)` — every write belongs to a batch |
| update a body | the previous 5 revisions are kept on the node |
| delete | a tombstone; the node and its links survive |
| hard removal | **not a tool** — the UI, by hand |

Supporting rules:

- **Delete takes one id.** There is no delete-by-query and no bulk form, so a
  successful injection costs one concept per call, each visible in the
  transcript.
- **Caps**: 30 concepts and 100 links per `remember`, 50k characters per body.
  Exceeding one is a rejection with nothing written, never a silent
  truncation. They also protect the process — embedding is in-process and
  CPU-bound, so a 300-concept call would pin the container long enough to fail
  its own healthcheck.
- **Results carry an untrusted-data envelope** stating that stored content is
  data, not instructions.
- **Errors are sanitised** and the path secret is redacted from them.

### `remember` asks rather than guesses

Per concept the result is `created`, `merged` or **`ambiguous`**. Ambiguous
writes nothing and returns candidates for an explicit decision; everything
unambiguous in the same call is still written, because rejecting a batch over
one fuzzy match would throw away a conversation's worth of knowledge.

The threshold is 0.80 cosine, measured rather than guessed:

```
WAL                 <-> Write-ahead logging   0.835   same thing
Write-ahead log     <-> Write-ahead logging   0.992   same thing
Write-ahead logging <-> Crash recovery        0.750   related, distinct
Backpressure        <-> unrelated             0.55-0.58
```

An earlier 0.85 let "WAL" through as a new concept. Both sides of the line are
pinned by regression checks, so moving it breaks a test rather than silently
changing behaviour.

### `cypher_read` is allowlisted, and here is why

A READ transaction does refuse graph writes — that part is enforced by the
database. But read mode does **not** cover the administrative surface. All of
these succeed inside one, verified on this server:

```
CALL dbms.listConfig()   ->  194 config entries
SHOW USERS               ->  1
SHOW TRANSACTIONS        ->  1
SHOW DATABASES           ->  2
```

So the guard is a positive allowlist: a query must start with MATCH, OPTIONAL,
WITH, UNWIND or RETURN, and may not contain `CALL`, `SHOW`, `TERMINATE`,
`LOAD` or any write clause. Comments and string literals are stripped before
scanning, so a keyword cannot be hidden in a comment. `LOAD CSV` is refused
outright: `file://` is already blocked by Neo4j's config, but the `http://`
case was inconclusive when probed, and it would be an SSRF primitive.

## Web UI auth

Auth.js v5, single admin from `.env` (`ADMIN_USERNAME` plus `ADMIN_PASSWORD`
or a bcrypt `ADMIN_PASSWORD_HASH`). `middleware.ts` gates everything except:

- **`/mcp/*`** — it has its own auth (a bearer token in a header, over an
  unguessable path segment, inside the WAF rule), and sending a connector an
  HTML login redirect would fail in a way that looks like a network fault.
  The decision lives in `src/lib/mcp-auth.ts` rather than in the route, so it
  can be tested without standing up HTTP: `npm run auth:check`.
- **`/api/health`** — the compose healthcheck calls it with no session. It
  answers anonymous callers with `{ok, backupStale}` only; the Neo4j version,
  schema counts and backup filenames are a small map of the box and stay
  behind a session.

## Checks

```bash
npm run auth:check       # 41 — the MCP auth decision; no containers needed

docker compose -f docker-compose.test.yml up -d
npm run graph:check      # 29 — graph core
npm run backup:check     # 23 — export/restore round trip
npm run tools:check      # 46 — tool behaviour and the security refusals
docker compose -f docker-compose.test.yml down
```

`auth:check` is the odd one out: the auth decision is a pure function of the
request and the environment, so it needs neither Neo4j nor Docker and runs in
about a second. That is most of why it lives in `src/lib/mcp-auth.ts` instead
of in the route.
