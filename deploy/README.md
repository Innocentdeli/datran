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
- **Resumable uploads (tus 1.0, `/api/uploads`)**: same body limit as ingest (one chunk per
  request). Partial uploads are staged in `UPLOAD_STAGING_DIR` (outside the upload storage) and
  expire after `UPLOAD_EXPIRY_HOURS` (default 24, removed by the cleanup job). Upload metadata and
  per-upload locks live in Redis; with several app instances the staging directory must be shared
  storage, since consecutive chunks of one upload may reach different instances.
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

## Observability

Code: `diocom-app/src/lib/observability` (server only).

**Logs.** Structured pino logs: JSON on stdout in production, pretty-printed in development
(`LOG_LEVEL`, `LOG_FORMAT=json|pretty`). Every line carries `service`, `instance`, and inside a
route also `requestId`, `route` (the route template, never the raw URL), `method` and, once a
session is resolved, `userId`. With tracing on, lines also get `trace_id`/`span_id`. One summary
line per request (`status`, `durationMs`). `X-Request-Id` is accepted from the client/proxy when
it is a safe token (8-128 chars of `[A-Za-z0-9._:-]`), otherwise generated, and is always sent
back on the response. Passwords, tokens, keys, cookies, Authorization headers, URL credentials,
URL fragments and client IPs are redacted (field paths plus a scrub of message/error text).

**Metrics.** `GET /api/metrics` returns Prometheus text for **that instance only**. It needs
`Authorization: Bearer $METRICS_TOKEN` and returns 404 when `METRICS_TOKEN` is unset. Caddy
answers 404 for `/api/metrics` from the internet. Series:

| Metric | Labels |
| --- | --- |
| `http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight` | `route` (template), `method`, `status` |
| `diocom_uploads_total`, `diocom_upload_bytes_total` | `outcome`, `backend` |
| `diocom_downloads_total`, `diocom_download_bytes_total` | `source` (`disk`, `decoded`, `memory_cache`, `reactor_store`, `external`) |
| `diocom_reactor_request_duration_seconds`, `diocom_reactor_errors_total` | `op`, `outcome` / `reason` |
| `diocom_stream_cache_requests_total` | `result` (`hit`/`miss`) |
| `diocom_prefetch_warms_total` | `outcome` |
| `diocom_rate_limit_rejections_total` | `scope`, `reason` (`limited`/`unavailable`) |
| `diocom_auth_attempts_total` | `method` (`password`, `signup`, `passkey`, `webauthn`, `file_password`, `google`, ...), `result` |
| `diocom_kv_errors_total` | `op` |
| `diocom_db_query_duration_seconds` | `backend`, `op` (SQL verb), `outcome` |
| `diocom_cleanup_runs_total`, `diocom_cleanup_duration_seconds` | `outcome` |
| default Node/process metrics | none |

Every label value is bounded: route templates are validated, methods and status codes are
normalised, and free-form labels are capped (anything new beyond the cap becomes `other`).

**Multiple instances.** Counters are per process, so with `--scale app=N` each replica exposes its
own numbers. Prometheus discovers every replica through Docker DNS (`dns_sd_configs` on `app`,
see `prometheus/prometheus.yml`) and scrapes each one; dashboards aggregate with `sum()`. Don't
scrape through Caddy or a load balancer, because you'd get a different instance on every scrape.

**Tracing.** If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, `src/instrumentation.ts` registers
OpenTelemetry (`@vercel/otel`, OTLP export, Next.js route spans). If it is unset, tracing is
off and does nothing. W3C `traceparent` is sent on calls to the reactor.

**Health.** `GET /api/health/live` returns 200 while the process serves requests.
`GET /api/health/ready` returns 200 or 503 with per-check JSON: the database must be reachable
and fully migrated, Redis must answer if `REDIS_URL` is set, and the reactor's `/health` must
answer if `STORAGE_BACKEND=reactor`. Each check times out after `HEALTH_TIMEOUT_MS` (default
2000). The compose `app` healthcheck uses readiness.

**Prometheus + Grafana (optional).**

```sh
# deploy/.env: METRICS_TOKEN=..., GRAFANA_ADMIN_PASSWORD=...
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile observability up -d
ssh -L 3001:127.0.0.1:3001 your-host   # Grafana -> http://localhost:3001 (dashboard "Datran app")
```

Prometheus reads the token from a compose secret, so it never appears in its config. Grafana is
bound to 127.0.0.1 and gets a provisioned datasource and dashboard (`grafana/`). The reactor
panel is a TODO until the reactor exposes Prometheus metrics (it has JSON `/store/stats` today).

## Billing

Code: `diocom-app/src/lib/billing` (plans, usage, credits, Stripe), migration `0003_billing_and_mobile_auth.sql`.

**Plans.** Anonymous (if `ALLOW_ANONYMOUS_UPLOADS` is not `false`), Free, and Pro (Stripe subscription, monthly
or yearly), plus pay-as-you-go credits. All limits come from `PLAN_<ANON|FREE|PRO>_*` env vars (see
`.env.example`; defaults: Free 200 MB/file, 2 GB storage, 10 GB downloads/month, 7-day links; Pro 5 GB/file,
500 GB, 1 TB/month, 30-day links; anonymous 100 MB/file, 2 GB/month per file, 24-hour links). `MAX_FILE_SIZE`
stays the hard per-file ceiling (default 1 GB) — raise it if Pro should upload more.

**Enforcement.** Uploads are checked at creation (multipart `Content-Length`, tus `Upload-Length`) and while
receiving; storage is reserved atomically at finalize and released when a file is deleted or expires. Refusals
are JSON `{ code, limit, message, upgrade, upgradeUrl: "/billing" }` with 413 (file too large for the plan) or
402 (quota). Downloads count against the **file owner's** monthly quota; beyond it the owner's credits pay
(`CREDITS_PER_GB`, debited atomically, never below zero), otherwise the downloader gets a friendly 402. Served
bytes (ranges included, cancelled downloads corrected to what was actually sent) are batched in Redis and
flushed to PostgreSQL by one instance every `BILLING_FLUSH_INTERVAL_MS`.

**Stripe setup (test mode first).**
1. Create products/prices: Pro monthly + Pro yearly (recurring) and one-time prices for credit packs; set
   `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_CREDITS_<N>` (N = credits in the pack).
2. Set `STRIPE_SECRET_KEY` (`sk_test_…`). Enable the Customer Portal (Dashboard → Settings → Billing → Portal).
3. Add a webhook endpoint `https://<domain>/api/billing/webhook` with events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `customer.subscription.created|updated|deleted`, `invoice.paid`,
   `invoice.payment_failed`, `charge.refunded`; put its signing secret in `STRIPE_WEBHOOK_SECRET`.
   Locally: `stripe listen --forward-to localhost:3000/api/billing/webhook` prints a `whsec_…` to use.

Entitlement is derived only from the webhook-maintained `subscriptions` table: `active`/`trialing` → Pro,
`past_due` → Pro for `BILLING_GRACE_DAYS` (default 7), anything else → Free. The checkout success redirect grants
nothing. Webhooks are verified over the raw body and processed idempotently (`processed_events` + idempotency
keys on every ledger entry). Refunded credit packs claw back only credits that were not spent yet. Without
`STRIPE_SECRET_KEY` the `/billing` page shows "billing not configured" and every account is Free.

**Mobile app auth.** `POST /api/mobile/token` (`{email,password}` or `{passkeyToken}`) returns a 15-minute
access JWT (audience `mobile`, key derived from `DIOCOM_SECRET`) and a 30-day single-use refresh token
(stored hashed). `POST /api/mobile/token/refresh` rotates it — reusing a spent token revokes the whole family —
and `POST /api/mobile/token/revoke` signs out. Upload, inbox, billing-usage and `GET /api/mobile/files` accept
`Authorization: Bearer <access token>` as well as the web session cookie.

Metrics: `diocom_quota_rejections_total`, `diocom_credit_transactions_total`, `diocom_egress_bytes_total`,
`diocom_egress_flushes_total`, `diocom_stripe_webhooks_total`, `diocom_mobile_token_requests_total`.

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

## Backup

A full backup has three parts, taken in this order by `deploy/backup.sh`:

1. **PostgreSQL** (`pg_dump -Fc`), which holds all app metadata. It is dumped first so that every file it
   references already exists when the reactor snapshot is taken.
2. **App storage** (`/data/app/storage` in the `app-data` volume, used when the app stores files
   locally).
3. **Reactor**: an online, consistent snapshot (`POST /store/backup`, the same code as
   `reactor-admin backup`). It holds one redb read transaction, copies every pack up to its committed
   end, every object file, the dictionaries, `state.json`, `node_id` and `cluster-leases.json`, and
   writes a `MANIFEST.json` with the SHA-256 of every file. Uploads keep working while it runs; GC and
   repairs pause until it finishes. Each run is incremental against the previous reactor backup: only
   new objects and changed packs are copied, and the rest is referenced. Keep the older reactor backup
   directories for as long as newer ones reference them, and prune whole chains.

```sh
deploy/backup.sh ./backups          # -> ./backups/<UTC stamp>/{postgres.dump,app-storage.tar.gz,...}
                                    #    + ./backups/reactor/<UTC stamp>/ (reactor snapshot)
REACTOR_FULL=1 deploy/backup.sh     # start a new full reactor chain
```

The reactor writes backups only below its `REACTOR_BACKUP_DIR`; without it `/store/backup` answers 403.
Add this to the `reactor` service in `docker-compose.yml` (writable by uid 10002):

```yaml
    environment:
      REACTOR_BACKUP_DIR: /backups
    volumes:
      - ${REACTOR_BACKUP_HOST_DIR:-./backups/reactor}:/backups
```

**Encryption keys are never part of a backup.** An encrypted store is backed up as ciphertext. Keep
`REACTOR_MASTER_KEY` / `REACTOR_MASTER_KEYS` in your secret store: a restore without the same keys is
refused, and the error names the missing key ids. Copy backups off the host (object storage, another
machine) and test restores regularly.

### Restore

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env stop app reactor
# reactor: verifies every file against MANIFEST.json, restores, then runs the deep fsck
# (decrypt + decode + hash of every object); any failure leaves nothing usable behind.
# Run with the same REACTOR_MASTER_KEY(S) as the source; the target must be empty unless --force.
reactor-admin restore ./backups/reactor/<stamp> /path/to/new/reactor-state
#   (then put that directory into the reactor-state volume, e.g. via a helper container)
# PostgreSQL:
docker compose ... exec -T postgres pg_restore -U datran -d datran --clean --if-exists < ./backups/<stamp>/postgres.dump
# app storage:
docker compose ... exec -T app sh -c 'cd /data/app && tar -xzf -' < ./backups/<stamp>/app-storage.tar.gz
docker compose ... start reactor app
```

`reactor-admin` is built from `core-reactor` (`cargo build --release --bin reactor-admin`). Incremental
reactor backups reference their bases by the path the reactor saw (`/backups/<name>`). Restore falls back
to a sibling directory with the same name, so restore from the whole `backups/reactor/` directory. A
restored reactor keeps its `node_id`: never run the old node and its restored copy at the same time in
one cluster.

### Reactor metrics

The reactor serves Prometheus metrics at `GET /metrics` (NETWORK_SPEC §8). `prometheus/prometheus.yml`
has a `reactor` job that authenticates with `Authorization: Bearer` from
`/run/secrets/reactor_metrics_token`. To enable it, set `REACTOR_METRICS_TOKEN` on the reactor, add a
compose secret `reactor_metrics_token` (`environment: REACTOR_METRICS_TOKEN`) and mount it into the
`prometheus` service. Set `REACTOR_LOG_FORMAT=json` for JSON logs; every response carries
`x-request-id`.

## Reactor cluster over QUIC (optional)

Reactors can exchange cluster traffic (inventory gossip, manifests, objects, leases, recipes) over
QUIC / HTTP/3 instead of HTTPS: one UDP connection per peer carries many object fetches in parallel
(NETWORK_SPEC §4 "QUIC transport"). It is node-to-node only; clients and the app still use TCP.

1. Give every node a certificate for the name/IP its peers dial, signed by a private CA
   (`REACTOR_TLS_CERT`, `REACTOR_TLS_KEY`, `REACTOR_TLS_CA`). QUIC refuses to start without them.
   For `REACTOR_QUIC_MTLS=true` the same certificate is the client certificate, so it needs the
   `clientAuth` extended key usage (or no EKU at all).
2. Set `REACTOR_QUIC_PORT=3005` (UDP) and list peers as `quic://10.0.0.2:3005` (or keep
   `https://` peers and set `REACTOR_PEER_TRANSPORT=quic`). A failed handshake falls back to
   `https://<same host>:<same port>` for 60 s; `quic-only` disables the fallback.
3. Open **UDP 3005 between the reactor hosts only** (in addition to TCP 3005), e.g.
   `ufw allow proto udp from 10.0.0.0/24 to any port 3005`, and publish it on the private interface:
   `ports: ["10.0.0.1:3005:3005/tcp", "10.0.0.1:3005:3005/udp"]` (never through Caddy, never public).
4. Check `GET /cluster/status` (`peers[].transport.transport` is `quic`, `transport.fallbacks` stays 0)
   and the `reactor_cluster_peer_requests_total{transport="quic"}` / `reactor_quic_*` metrics.
   Large UDP buffers help throughput: `sysctl -w net.core.rmem_max=8388608 net.core.wmem_max=8388608`.