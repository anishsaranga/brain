# brain

A self-hosted knowledge graph you feed from Claude conversations and revise over
time. Three surfaces in one service:

- **Write from Claude** — a remote MCP server you add as a custom connector, so
  any conversation can add concepts and the links between them.
- **See it** — an interactive graph, coloured by how well you know each thing.
- **Revise it** — FSRS spaced repetition where each due card is reviewed
  *beside its neighbourhood*, so you rehearse the connections and not just the
  fact.

There are plenty of Neo4j-backed memory servers for MCP. None of them schedule
review or render a walkable session, which is the reason this is one app rather
than three glued together.

> Status: milestones 1–3 are built (transport, graph core, backups). The MCP
> tools, explorer and review session are in progress. See `DEPLOY.md`.

## Design principles

These drive most of the decisions and are worth reading before changing
anything.

1. **Storage and rehearsal are separate opt-ins.** A concept that lands in the
   graph is *not* automatically a flashcard. Conflating "I saved this" with "I
   must memorise this" is what makes these systems unbearable by week three, so
   concepts start `tracked: false` and are promoted deliberately.
2. **The model does the thinking; the server does the bookkeeping.** There is
   no LLM key on the server, ever. Extraction, disambiguation and consolidation
   are Claude's job. Dedupe, embed, write and schedule are the server's.
3. **The server never silently guesses.** Where a write is ambiguous it refuses
   and asks, rather than merging two concepts that should not be merged.

## How it fits together

```
claude.ai ──HTTPS──▶ Cloudflare (WAF: /mcp/* only from Anthropic's egress range)
                          │  Tunnel
                          ▼
                 <HOSTNAME> → http://localhost:9999
                          │
                 ┌────────┴────────┐
                 │  brain-web      │ Next.js 16: /mcp, explorer, review
                 └────────┬────────┘
                          │ bolt (internal docker network)
                 ┌────────┴────────┐
                 │  brain-neo4j    │ Neo4j Community — loopback only
                 └─────────────────┘
```

- **Neo4j Community** for the graph. Vector and full-text indexes are native,
  so semantic search needs no extra service.
- **Local embeddings** (`all-MiniLM-L6-v2`, 384-dim) baked into the image and
  warmed at boot. No API key, no network dependency at runtime.
- **Hybrid search** fuses full-text and vector results by weighted reciprocal
  rank. Full-text wins on exact jargon, vectors on "that thing about
  backpressure"; either alone visibly fails half the time.
- **Closed relationship vocabulary** (`PREREQUISITE_OF`, `RELATED_TO`,
  `EXAMPLE_OF`, `CONTRASTS_WITH`, `PART_OF`, `CITES`), enforced as an enum in
  the MCP tool schema. The cheapest hygiene mechanism for a graph fed by a
  model across hundreds of independent conversations is to make the invalid
  value unrepresentable.

## Running it

```bash
cp .env.example .env     # fill in the secrets it describes
docker compose up -d --build
curl -s http://127.0.0.1:9999/api/health
```

See `DEPLOY.md` for the full procedure, including putting it behind a
Cloudflare Tunnel and adding it to Claude as a connector.

## Checks

```bash
npm run auth:check       # MCP auth + the sign-in allowlist — no containers needed

docker compose -f docker-compose.test.yml up -d
npm run graph:check      # graph core: upsert, links, neighbourhoods, search
npm run backup:check     # export → wipe → import → assert identical
npm run tools:check      # tool behaviour, caps, and the security refusals
npm run explorer:check   # soft delete across the UI, and hard delete's guards
docker compose -f docker-compose.test.yml down
```

The three that need a database run in Linux against a **throwaway** Neo4j on
7688, never the real one — the scripts hold an allowlist of permitted targets
and refuse anything else, because the first thing `backup:check` does is
delete every node it can reach.

## Backups

The graph is the only thing here that cannot be rebuilt from this repo, so:

- **nightly JSON export** — online, portable, version-independent. The primary.
- **nightly markdown export** — one file per concept; reads as an Obsidian
  vault. The escape hatch.
- **monthly `neo4j-admin` dump** — byte-exact, needs ~30s of downtime, because
  on Community a dump cannot run against a mounted database and online backup
  is an Enterprise feature.

The restore is rehearsed on every check run rather than once: `backup:check`
builds a fixture, exports it, deletes everything, imports, and asserts the
result is identical — ids, review state, datetimes, unicode, edge properties,
and embeddings regenerated so semantic search still works.

`/api/health` reports how stale the newest export is, measured from its mtime
rather than its filename.

## Licence

Personal project; no licence granted.

## Security posture

This is write access to a knowledge base, driven by a language model, over a
public endpoint — and content ingested today is read back into other
conversations weeks later. That is indirect prompt injection by construction,
so the defences are structural rather than instructional:

- **Nothing reachable over MCP is irreversible.** Batched writes can be undone,
  overwritten bodies keep their previous revisions, and delete is a tombstone.
  Hard removal is a human action in the UI.
- **Delete takes one id.** No bulk form and no delete-by-query, so a successful
  injection costs one concept per call and every call is in the transcript.
- **Per-call caps** on concepts, links and body size, rejected rather than
  silently truncated.
- **`cypher_read` is allowlisted, not denylisted**, because a Neo4j read
  transaction refuses writes but still permits `CALL dbms.listConfig()`,
  `SHOW USERS` and `SHOW TRANSACTIONS`. The database is not the boundary there,
  so the guard is.
- **Stored content is returned inside an untrusted-data envelope**, and errors
  are sanitised so neither endpoint credential can leak through one.
- **Hard delete is the one irreversible operation, and it is UI-only.** It
  is unreachable over MCP, requires the concept to be tombstoned first, and
  requires its name typed exactly — both guards enforced in the data layer,
  not the form, since a guard that lives in a React component is one a stray
  request never has to pass. The page shows which links it would sever
  before offering the control.
- **The web UI has no password.** Google sign-in, with an allowlist that is
  the real boundary — the provider proves identity, never authorisation. It
  fails closed when unset, checks `email_verified` rather than trusting it,
  and is re-checked on every request so revocation is immediate.
- **The MCP credential is a header, not a URL.** A bearer token on
  `Authorization` or `X-Brain-Token`, with the unguessable path segment kept
  underneath it as a second factor and a Cloudflare WAF rule outside both.
  Every refusal is the same bare 404, whatever the reason, so a prober cannot
  learn that the endpoint exists — let alone which half they got wrong.

The checks assert the refusals, not just the happy paths.
