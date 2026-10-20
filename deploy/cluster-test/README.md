# Reactor multi-node cluster test

Three Datran reactors (`node-a`, `node-b`, `node-c`) in separate containers on one Docker network, driven
from the host through the Python client (`clients/python`) and the docker CLI.

```
python deploy/cluster-test/run_cluster_test.py          # build, start, run all 9 scenarios, tear down
```

Options: `--no-build` (reuse images), `--keep` (leave the cluster running for inspection),
`--only 5,6` (scenarios 1 and 2 always run when a later one is chosen: they create the data set),
`--rmi` (also delete the test images). The exit code is 0 only if every scenario passed. A full run takes
about 10–20 minutes, most of it in scenario 5 (throughput under 100 ms delay).

## Requirements

- Docker with Compose v2.17+ (`additional_contexts: service:`), Linux containers. On Windows / macOS,
  Docker Desktop works: `tc` and `iptables` run inside the containers' own network namespaces (`NET_ADMIN`).
- Python 3.9+ (stdlib only; the repo's `clients/python/src` is put on `sys.path`).
- ~4 GB free disk for the Rust build cache and images, ~2 GB for volumes during the run.
- Free host ports 34431–34433 (published on 127.0.0.1 only).

## What gets started (`docker-compose.cluster.yml`)

| Piece | Details |
| :--- | :--- |
| Images | `deploy/Dockerfile.reactor` unchanged (production image), extended by `Dockerfile.cluster-test` with `iproute2`, `iptables`, `openssl` and `reactor-admin`. The extra cargo step reuses the production build's cached layer. The production image stays lean. |
| `certgen` | one-shot init container: test CA + per-node certs (SAN `node-x`, `localhost`, `127.0.0.1`, server + client auth) into a `certs` volume |
| Nodes | own volume each, **different master keys** (`REACTOR_REQUIRE_ENCRYPTION=true`), shared `REACTOR_TOKEN` / `REACTOR_CLUSTER_TOKEN`, HTTPS + QUIC on 4433 (TCP/UDP), `REACTOR_QUIC_MTLS=true`, peers `quic://node-x:4433` (HTTPS fallback on the same port), `REACTOR_MIN_REPLICAS=2`, gossip every 1 s, scrub every 3 s, `REACTOR_BACKUP_DIR=/backups` (shared `backups` volume), `cap_add: NET_ADMIN` |
| node-c | `REACTOR_STORE_MAX_BYTES=8 GiB`: repair picks the node with the most free capacity, so with all nodes up node-b (unlimited) gets the second replica of everything written to node-a. That keeps node-c a pure *remote reader*, which the scenarios rely on. |

All tokens and keys in the compose file are fixed public test values.

## Scenarios

| # | What it does | What it proves |
| :--- | :--- | :--- |
| 1 | `/health`, `/cluster/status` on every node; mTLS probe with `curl --http3-only` from another container | every peer healthy, last transport `quic`, 0 HTTP(S) peer requests, 0 fallbacks, 0 handshake failures; QUIC refuses a client without a certificate and accepts a node certificate |
| 2 | 50 files (1 KB–64 MiB: random, text, marker, shared 4 MiB regions, 4 duplicates) PUT to node-a; wait for node-b's repair copy; full + range + suffix reads on node-c, plus a 416 | content-addressed ids, chunk dedup across files, duplicate pins, replication to 2 holders, remote reads (`x-reactor-remote: 1`) byte-exact via SHA-256 |
| 3 | 6 files read 4x each on node-c while a monitor polls every node's inventory every 0.3 s | gravity pull on node-c; a cold holder drops its copy only after 2 leases (lease counters), origin transfer when node-a drops; never fewer than 2 holders |
| 4 | `docker compose stop node-b`; delete 3 files on node-a; restart; then `docker compose kill` (SIGKILL) during an upload to node-b | exactly one repair pull per under-replicated file (pull counters per node: no stampede); tombstones stop the restarted node from resurrecting deletes; crash recovery after SIGKILL (store and inventory consistent, local files byte-exact) |
| 5 | `tc netem` on node-c: egress 100 ms delay + 2 % loss, ingress 2 % loss (ifb; falls back to shaping the peers' egress towards node-c). Same measurement over QUIC and with node-c recreated with `https://` peers | reads stay byte-exact under delay/loss; throughput of a 4 MiB remote read and a 16 MiB gravity pull, QUIC vs HTTPS, with and without netem |
| 6 | `iptables` drops all traffic between node-a and node-c; reads and uploads during the partition; heal | node-b stays healthy in node-c's view (one dead peer must not stall the gossip round); reads on node-c are served from node-b in < 10 s (remotely, or locally after node-c already repaired the file from node-b); after healing every file has ≥ 2 holders, all peers are healthy, and QUIC replaces the HTTPS fallback once the retry window (60 s) has passed |
| 7 | flip 8 bytes in two object files in node-b's volume | scrub detects the AEAD/hash failure, quarantines the object and repairs it from a peer; every file on node-b still reads byte-exact |
| 8 | `POST /store/backup` on node-a, stop it, wipe its volume, `reactor-admin restore`, start | the documented online backup / offline restore procedure works with encryption on; same `node_id`; every file node-a held reads locally byte-exact |
| 9 | `grep` every node volume and the backup volume for a marker string from the uploaded files | no plaintext at rest. Control: the same marker *is* visible in a `/compress` blob, so compression alone would not hide it |

## Limits

- **One host.** The "machines" share one kernel, CPU, disk and page cache. Throughput numbers are about
  relative behaviour on this host, not capacity planning.
- **No real WAN.** netem adds fixed delay and random loss. It does not model jitter, reordering, bandwidth
  limits, real congestion, NAT or middleboxes that block UDP. A QUIC vs HTTPS result here is not a
  prediction for a real WAN.
- **Partition** is a clean bidirectional drop between two nodes. Asymmetric partitions, flapping links and
  clock skew are not tested.
- **Corruption** is injected only into file objects (not pack records or the redb index).
- **Disk faults** (full disk, fsync errors) and **power loss** are not tested. SIGKILL is not power loss:
  the page cache survives.
- One run per measurement. Expect run-to-run noise.
