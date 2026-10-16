# Deploying `brain` on the homelab

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
# Fill in NEO4J_PASSWORD   (openssl rand -hex 20)
#     and MCP_PATH_SECRET  (openssl rand -hex 24)
```

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

## Data and backups

The graph is **the only irreplaceable thing on this box**. Every other service
here is reconstructible from a repo; this one *is* the asset.

A constraint that shapes the strategy: `neo4j-admin database dump` **requires
the database to be offline**, and online backup (`neo4j-admin database backup`)
is Enterprise-only. On Community, a dump means stopping the database. Hence:

- **Primary — nightly JSON export** (`scripts/export-json.mjs`): all nodes and
  edges to a dated file in `./backups`. Runs online, version-independent,
  human-readable, and restorable into any graph DB including a future non-Neo4j
  one. For an irreplaceable asset, format independence beats restore speed.
- **Secondary — weekly `neo4j-admin database dump`** (`scripts/dump.ps1`) with a
  brief stop/start, for a fast whole-DB restore.
- **Tertiary — markdown export**: one file per concept, so there is always a
  plain-text copy of prose you wrote, and an Obsidian-shaped exit.
- **Backups currently land on the same disk** (`./backups`, bind-mounted into
  the Neo4j container). Better than nothing, worse than off-box — stated plainly
  rather than implied otherwise.
- **Restore must be rehearsed at least once.** An untested backup is not a
  backup.

*(The backup scripts land in milestone 3. Until then there is nothing
irreplaceable in the volume.)*

## Status

Milestone 1 (walking skeleton) is complete: both containers healthy, schema
applied, MCP `ping` answering over Streamable HTTP, and the secret-path guard
returning 404 on a wrong segment. Remaining: graph core, backups, the nine
tools, explorer, review session.
