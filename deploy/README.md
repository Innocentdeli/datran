# Deploying Datran with HTTP/3

Caddy terminates TLS and serves **HTTP/3 (QUIC, UDP 443)**, HTTP/2 and HTTP/1.1, and
reverse-proxies to the Next.js app. The Rust reactor is internal only.

```
browser ──h3 / h2──▶ Caddy :443 (tcp+udp) ──http/1.1──▶ app :3000 ──▶ reactor :3005 (internal)
```

| File | Purpose |
|---|---|
| `caddy/Caddyfile` | Production site: automatic ACME TLS, h1/h2/h3, server timeouts |
| `caddy/Caddyfile.local` | Local test: `tls internal`, ports 8080/8443, no trust-store install |
| `caddy/app.caddy` | Shared site config (body limits, headers, compression, proxy) imported by both |
| `docker-compose.yml` | caddy + app + reactor, UDP 443 published, volumes for certs, app data, reactor state |
| `Dockerfile.app`, `Dockerfile.reactor` | Images (build context = repo root) |
| `.env.example` | Copy to `deploy/.env` (git-ignored) |

## What the proxy does

- **HTTP/3**: Caddy enables h3 by default and adds `Alt-Svc: h3=":443"; ma=2592000` to
  every HTTPS response. Browsers make the first request over TCP (h2), see Alt-Svc, then use
  QUIC. So the first load usually shows `h2`, later loads `h3`.
- **Streaming**: `flush_interval -1` (downloads and SSE progress go straight through),
  `request_buffers 0` / `response_buffers 0` (uploads are streamed to the app, not spooled).
- **Timeouts** for multi-GB transfers: `read_header 30s`, `read_body 6h` (max time to receive
  one request incl. body), no write timeout (long downloads), `idle 5m`. Upstream:
  `dial_timeout 10s`, `response_header_timeout 15m` (the app compresses/stores an upload
  before answering).
- **Body limits**: `/api/ingest*` up to `INGEST_MAX_BODY` (default `201MiB`; keep it just above
  the app's `MAX_UPLOAD_BYTES` = 200 MiB plus multipart overhead; raise both together),
  everything else `DEFAULT_MAX_BODY` (16 MiB). Over the limit: `413`.
- **Security headers**: HSTS (`max-age=31536000`; add `includeSubDomains`/`preload` only if
  every subdomain is HTTPS), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`
  plus `Content-Security-Policy: frame-ancestors 'self'` (the PDF viewer frames same-origin
  `/api/stream`), `Referrer-Policy: strict-origin-when-cross-origin` and a restrictive
  `Permissions-Policy` (both only if the app didn't set them), `Server`/`X-Powered-By` removed.
  **No script/style CSP is set at the proxy**: Next.js inline bootstrap scripts and
  framer-motion inline styles need per-request nonces, so a correct CSP has to be emitted by
  the app (e.g. middleware with nonces). A static proxy CSP would either break the app or be
  `unsafe-inline` and worthless.
- **Compression**: zstd/gzip for text types only (HTML, CSS, JS, JSON, XML, SVG,
  plain text, >= 1 KiB), never for requests with a `Range` header and never on
  `/api/stream`, `/api/thumbnail`, `/api/ingest`, `/api/progress`. Responses that already have
  `Content-Encoding` pass through unchanged. Note: `next start` gzips responses itself by
  default; set `compress: false` in `diocom-app/next.config.ts` to let these proxy rules
  decide everything (and to keep Next from compressing `/api/stream` bodies).
- **Client IPs**: Caddy drops incoming `X-Forwarded-*` from untrusted clients and sets its
  own, so compose runs the app with `TRUST_PROXY=true`.
- **Reactor**: no `ports:` mapping and not proxied. It binds `0.0.0.0` only inside the
  `internal` Docker network (which requires `REACTOR_TOKEN` + `REACTOR_CLUSTER_TOKEN`).
  Multi-node clusters connect reactors directly with their own TLS (`REACTOR_TLS_*`); for that,
  publish 3005 on a private interface and set `internal: false` on the network so it can reach
  `REACTOR_PEERS`. Never route reactor traffic through Caddy.

## Setup

1. **DNS**: an `A` (and/or `AAAA`) record for your domain pointing at the server. No proxying
   CDN in front (an orange-cloud/HTTP proxy would terminate QUIC itself).
2. **Firewall / security group**: open **TCP 80** (ACME HTTP-01 + redirect), **TCP 443** and
   **UDP 443** (QUIC). UDP 443 is the one most often forgotten; without it browsers silently
   stay on HTTP/2. Example: `ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp`.
   Large UDP receive buffers help QUIC throughput on Linux:
   `sysctl -w net.core.rmem_max=7500000 net.core.wmem_max=7500000`.
3. **Config**: `cp deploy/.env.example deploy/.env`, set `SITE_ADDRESS`, `NEXTAUTH_URL`,
   `WEBAUTHN_*`, `DIOCOM_SECRET`, `POSTGRES_PASSWORD` (or an external `DATABASE_URL`),
   `REDIS_PASSWORD`, `REACTOR_TOKEN`, `REACTOR_CLUSTER_TOKEN`.
4. **Run**: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`.
   Caddy obtains the certificate on first start (watch `docker compose logs -f caddy`).

Volumes: `caddy-data` (certificates; keep it or you'll hit ACME rate limits), `app-data`
(local uploads), `db-data` (PostgreSQL: all metadata — back it up), `reactor-state`
(populations, dictionaries, object store; mounted read-only into the app for the TS fallback
decoder).

## Database

- **PostgreSQL is required in production.** With `NODE_ENV=production` the app refuses to start
  when `DATABASE_URL` is unset, the server is unreachable, or migrations are pending/inconsistent.
  The JSON store (`LOCAL_DB_PATH`) is a development/test emulator only; the old
  `DB_ALLOW_LOCAL_FALLBACK` escape hatch was removed (it is ignored, with an error log).
- **Migrations** are numbered SQL files in `diocom-app/migrations/` applied by
  `diocom-app/src/db/migrate.ts`: each in its own transaction, recorded in `schema_migrations`
  with a SHA-256 checksum, under a PostgreSQL advisory lock (replicas starting together are safe).
  The runner refuses to run if an applied file was edited or removed, or a new file is numbered
  below the latest applied one — never edit a released migration, add `NNNN_next.sql` instead.
- Commands (from `diocom-app/`, reading `DATABASE_URL` from the env or `.env.local`):
  `npm run db:migrate` (apply) and `npm run db:status` (read-only; exit 1 if not current).
  Nothing in the tooling drops or resets data (the old destructive `scripts/apply_schema.js` and
  the ad-hoc schema scripts are gone).
- **Compose** runs a `postgres:16-alpine` service (internal network, `db-data` volume) and the app
  container runs `npm run db:migrate` before `next start`; a failing migration stops the container
  before it serves traffic. Outside compose, either run `db:migrate` as a release step or set
  `DB_AUTO_MIGRATE=true` to migrate on server start.
- **Existing databases** created by the old `initializeSchema()` are detected (tables present, no
  `schema_migrations`), verified table-by-table/column-by-column, and marked as `0001` (baseline)
  instead of failing; columns/tables that old versions added lazily (`files.reactor_*`,
  `access_events`) are created first. A schema that does not match is refused with the list of
  what is missing. Take a `pg_dump` before the first migrate of an existing database.

## Running several app instances (Redis)

Everything an app instance used to keep in its own memory and that must be consistent across
instances lives in Redis (`diocom-app/src/lib/kv`):

| State | Redis mechanism |
| --- | --- |
| Rate limits (all routes, sign-in, unlock) | sliding-window log, one Lua script (atomic, Redis clock) |
| Passkey login tokens | `SET PX` 2 min under SHA-256(token); redeemed with `GETDEL` (exactly once) |
| WebAuthn challenges | `SET PX` 5 min per user+purpose; consumed with `GETDEL` before verifying |
| Swarm signaling | peer secret `SET NX PX` (id claimed once), bounded live sets, bounded mailbox lists (`RPUSH`+`LTRIM`, drained in `MULTI`) |
| Upload progress (SSE) | pub/sub channel per upload id + last-state key, so `/api/progress` works on any instance |
| Swarm daily credit cap | capped increment (Lua) |
| Cleanup job | lock `SET NX PX` + compare-and-delete/renew (Lua): one instance per round |
| Prediction | access events and file deletions broadcast via pub/sub; per-instance metrics aggregated for the admin view; reactor demand touches de-duplicated |

The decoded-file stream cache stays per instance on purpose (each serve re-checks the DB first).

- The compose file runs `redis:7-alpine` on the `internal` network only (no published port),
  password-protected (`REDIS_PASSWORD`), **persistence off** (all keys expire within minutes; a
  restart only drops in-flight tokens/progress and resets rate-limit windows) and
  `maxmemory-policy noeviction` (when full, writes fail and the app fails closed instead of
  silently evicting rate-limit state). The app gets `REDIS_URL` and `REQUIRE_REDIS=true`.
- Scale out: `docker compose ... up -d --scale app=3`. Caddy resolves `app` via Docker DNS; for
  active load balancing and health checks across replicas, use dynamic upstreams in
  `caddy/app.caddy` (`reverse_proxy { dynamic a app {$APP_PORT:3000} }`). Sessions are stateless
  JWTs, so no sticky sessions are needed.
- Multiple instances also need shared storage (`STORAGE_BACKEND=reactor` or `s3`); local disk
  storage is per instance. They share the one PostgreSQL (see [Database](#database)).
- Without `REDIS_URL` the app uses in-process state and, in production, logs a prominent warning
  that it must run as a **single** instance (legitimate for small deployments).
  `REQUIRE_REDIS=true` turns a missing `REDIS_URL` into a startup failure. Redis >= 6.2 required.
- If Redis becomes unreachable, rate-limited routes answer 503 (fail closed), passkey tokens
  cannot be redeemed, and signaling/progress return errors; nothing falls back to per-process state.

## Verifying HTTP/3

- `curl --http3-only -sI https://datran.example.com/` → `HTTP/3 200`. Needs a curl built with
  HTTP3 (`curl --version` lists `HTTP3` under Features). Stock Windows curl and many distro
  builds don't; use Docker: `docker run --rm alpine/curl-http3 curl --http3-only -sI https://datran.example.com/`.
- `curl -sI https://datran.example.com/` → contains `alt-svc: h3=":443"; ma=2592000`.
- Browser: DevTools → Network → right-click the header row → enable **Protocol**; reload twice.
  Requests show `h3`. The app's footer and `/network` page show the protocol measured from
  `PerformanceNavigationTiming.nextHopProtocol`.
- Server side: `ss -ulpn | grep :443` shows Caddy on UDP 443.

## Local test (no domain, no Docker)

Download a Caddy release binary (single file, no install) from
https://github.com/caddyserver/caddy/releases, start the app (`cd diocom-app && npm run dev`,
port 3001), then:

```sh
# from the repo root
APP_HOST=localhost APP_PORT=3001 caddy run --config deploy/caddy/Caddyfile.local --adapter caddyfile
# PowerShell: $env:APP_HOST='localhost'; $env:APP_PORT='3001'; caddy run --config deploy/caddy/Caddyfile.local --adapter caddyfile
```

Open https://localhost:8443 (accept the warning: the local CA is deliberately not installed
into your trust store; `caddy trust` would install it). Check h3 from Docker against the host:

```sh
docker run --rm --add-host=hostgw:host-gateway alpine/curl-http3 sh -c \
  'IP=$(grep hostgw /etc/hosts | head -1 | cut -f1); curl -sk --http3-only --resolve localhost:8443:$IP -o /dev/null -w "%{http_version} %{http_code}\n" https://localhost:8443/'
# -> 3 200
```

Validate config changes with `caddy validate --config deploy/caddy/Caddyfile --adapter caddyfile`
(set `SITE_ADDRESS` first) and `caddy fmt --overwrite deploy/caddy/*`.
