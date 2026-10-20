#!/usr/bin/env python3
"""Multi-node cluster test for the Datran reactor (three containers, see README.md).

    python deploy/cluster-test/run_cluster_test.py [--no-build] [--keep] [--only 1,2,5]

Builds deploy/Dockerfile.reactor (+ the test image), starts node-a/b/c with docker-compose.cluster.yml,
drives every scenario through the ports published on 127.0.0.1 (Python stdlib client from
clients/python) and the docker CLI, prints PASS/FAIL with measured numbers and a summary table, and
tears everything down (containers, network, volumes). Exit code 0 only when every scenario passed.
Python >= 3.9, stdlib only.
"""
from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
import random
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Set, Tuple

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "clients" / "python" / "src"))

from datran_client import (  # noqa: E402
    ApiError,
    Client,
    ClusterAdmin,
    DatranError,
    NotFoundError,
    RangeNotSatisfiableError,
)

COMPOSE_FILE = HERE / "docker-compose.cluster.yml"
PROJECT = "datran-ct"
NODES = ["node-a", "node-b", "node-c"]
PORTS = {"node-a": 34431, "node-b": 34432, "node-c": 34433}
TOKEN = os.environ.get("CT_REACTOR_TOKEN", "cluster-test-reactor-token")
CTOKEN = os.environ.get("CT_CLUSTER_TOKEN", "cluster-test-cluster-token")
MARKER = b"DATRAN-PLAINTEXT-MARKER-7f3c9a1e5b"
KiB, MiB = 1 << 10, 1 << 20
HTTPS_PEERS_C = "https://node-a:4433,https://node-b:4433"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Fail(Exception):
    pass


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


# ------------------------------------------------------------------------------------------ docker


def run(cmd: List[str], check_rc: bool = True, env: Optional[Dict[str, str]] = None, timeout: float = 900) -> subprocess.CompletedProcess:
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=full_env, timeout=timeout)
    if check_rc and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} -> exit {p.returncode}: {(p.stderr or p.stdout).strip()[-2000:]}")
    return p


def compose(*args: str, check_rc: bool = True, env: Optional[Dict[str, str]] = None, timeout: float = 900) -> subprocess.CompletedProcess:
    return run(["docker", "compose", "-f", str(COMPOSE_FILE), "-p", PROJECT, *args], check_rc, env, timeout)


def sh(node: str, script: str, check_rc: bool = True) -> subprocess.CompletedProcess:
    """Runs a shell script as root inside a node container."""
    return compose("exec", "-T", "-u", "0", node, "sh", "-c", script, check_rc=check_rc, timeout=300)


def node_ip(node: str) -> str:
    cid = compose("ps", "-q", node).stdout.strip()
    return run(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", cid]).stdout.strip()


# ------------------------------------------------------------------------------------------ test data


@dataclass
class TFile:
    name: str
    kind: str  # random | text | marker | shared
    size: int
    seed: int
    ctype: str = "application/octet-stream"
    sha: str = ""

    @property
    def key(self) -> Tuple[str, int, int]:
        return (self.kind, self.size, self.seed)


WORDS = (
    "alpha beta gamma delta reactor chunk manifest replica gravity lease tombstone quic stream "
    "packet object index scrub fusion pack record cluster node region demand drop repair"
).split()


@functools.lru_cache(maxsize=1)
def shared_block() -> bytes:
    return random.Random(999).randbytes(4 * MiB)


@functools.lru_cache(maxsize=8)
def _gen(kind: str, size: int, seed: int) -> bytes:
    r = random.Random(seed)
    if kind == "random":
        return r.randbytes(size)
    if kind == "marker":  # incompressible bytes with the marker every 32 KiB (survives compression)
        b = bytearray(r.randbytes(size))
        for off in range(0, max(1, size - len(MARKER)), 32 * KiB):
            b[off : off + len(MARKER)] = MARKER
        return bytes(b[:size])
    if kind == "text":
        out, n, i = [], 0, 0
        while n < size:
            line = " ".join(r.choice(WORDS) for _ in range(12))
            if i % 40 == 0:
                line += " " + MARKER.decode()
            line += f" #{i}\n"
            out.append(line)
            n += len(line)
            i += 1
        return "".join(out).encode()[:size]
    if kind == "shared":  # unique head + shared 4 MiB region + unique tail (cross-file dedup)
        head = r.randbytes(size // 3)
        tail = r.randbytes(max(0, size - len(head) - 4 * MiB))
        return (head + shared_block() + tail)[:size]
    raise ValueError(kind)


def gen(f: TFile) -> bytes:
    return _gen(*f.key)


def make_dataset() -> List[TFile]:
    r = random.Random(42)
    fs: List[TFile] = []
    for i, s in enumerate([1000, 3 * KiB, 20 * KiB, 200 * KiB, 1536 * KiB]):
        fs.append(TFile(f"text-{i}", "text", s, 100 + i, "text/plain"))
    for i, s in enumerate([1 * KiB, 64 * KiB, 300 * KiB, 2 * MiB, 5 * MiB]):
        fs.append(TFile(f"marker-{i}", "marker", s, 200 + i))
    for i in range(15):
        fs.append(TFile(f"rand-{i}", "random", int(2 ** r.uniform(10, 23)), 300 + i))  # 1 KiB .. 8 MiB
    for i in range(6):
        fs.append(TFile(f"shared-{i}", "shared", r.randint(6, 12) * MiB + r.randint(0, MiB), 400 + i))
    for i in range(7):
        fs.append(TFile(f"large-{i}", "random", r.randint(8, 16) * MiB + r.randint(0, MiB), 500 + i))
    fs.append(TFile("huge-0", "random", 32 * MiB, 600))
    fs.append(TFile("huge-1", "random", 64 * MiB, 601))
    fs.append(TFile("shared-big", "shared", 24 * MiB, 602))
    for i in range(5):
        fs.append(TFile(f"small-{i}", "random", r.randint(4, 900) * KiB, 700 + i))
    # duplicates (same content as earlier files -> same file id, second pin)
    for src in (2, 12, 27, 36):
        o = fs[src]
        fs.append(TFile(f"dup-of-{o.name}", o.kind, o.size, o.seed, o.ctype))
    assert len(fs) == 50, len(fs)
    for f in fs:
        f.sha = hashlib.sha256(gen(f)).hexdigest()
    return fs


class HashSink:
    def __init__(self) -> None:
        self.h = hashlib.sha256()
        self.n = 0

    def write(self, b: bytes) -> int:
        self.h.update(b)
        self.n += len(b)
        return len(b)


# ------------------------------------------------------------------------------------------ cluster access


class Cluster:
    def __init__(self, ca: str):
        self.ctx = ssl.create_default_context(cafile=ca)

    def url(self, node: str) -> str:
        return f"https://127.0.0.1:{PORTS[node]}"

    def client(self, node: str, timeout: float = 300, retries: int = 3) -> Client:
        return Client(self.url(node), TOKEN, timeout, max_retries=retries, ssl_context=self.ctx)

    def admin(self, node: str, timeout: float = 10) -> ClusterAdmin:
        return ClusterAdmin(self.url(node), CTOKEN, timeout, max_retries=0, ssl_context=self.ctx)

    def inventory(self, node: str, timeout: float = 10) -> Set[str]:
        inv = self.admin(node, timeout).inventory()
        return set(inv.added)

    def status(self, node: str) -> dict:
        return self.client(node, 15, 1).cluster_status().raw

    def metrics(self, node: str) -> dict:
        return self.status(node)["metrics"]

    def stats(self, node: str) -> dict:
        return self.client(node, 15, 1).store_stats().raw

    def healthy(self, node: str) -> bool:
        try:
            self.client(node, 5, 0).health()
            return True
        except DatranError:
            return False

    def holders(self, invs: Dict[str, Set[str]], fid: str) -> List[str]:
        return [n for n in NODES if fid in invs.get(n, set())]

    def read_verify(self, node: str, f: TFile, rng=None, expect_remote: Optional[bool] = None) -> Tuple[int, bool, float]:
        """Reads a file (or a range) and checks it byte-exactly. Returns (bytes, remote, seconds)."""
        c = self.client(node)
        t0 = time.perf_counter()
        if rng is None:
            sink = HashSink()
            res = c.store_get_to(f.sha, sink, range=None)
            dt = time.perf_counter() - t0
            check(sink.n == f.size, f"{node} {f.name}: got {sink.n} bytes, want {f.size}")
            check(sink.h.hexdigest() == f.sha, f"{node} {f.name}: SHA-256 mismatch")
            n = sink.n
        else:
            res = c.store_get(f.sha, range=rng)
            dt = time.perf_counter() - t0
            data = gen(f)
            if isinstance(rng, int):
                want = data[rng:]
            else:
                s, e = rng
                want = data[s : (e + 1 if e is not None else None)]
            check(res.status == 206, f"{node} {f.name} range {rng}: status {res.status}")
            check(res.data == want, f"{node} {f.name} range {rng}: bytes differ ({len(res.data or b'')} vs {len(want)})")
            n = len(want)
        remote = res.headers.get("x-reactor-remote") == "1"
        if expect_remote is not None:
            check(remote == expect_remote, f"{node} {f.name}: x-reactor-remote={remote}, expected {expect_remote}")
        return n, remote, dt


def wait_until(pred: Callable[[], bool], timeout: float, what: str, interval: float = 0.5) -> float:
    t0 = time.perf_counter()
    last_exc: Optional[BaseException] = None
    while True:
        try:
            if pred():
                return time.perf_counter() - t0
        except Exception as e:  # noqa: BLE001 - transient errors while nodes restart
            last_exc = e
        if time.perf_counter() - t0 > timeout:
            raise Fail(f"timeout after {timeout:.0f}s waiting for {what}" + (f" (last error: {last_exc})" if last_exc else ""))
        time.sleep(interval)


class HolderMonitor(threading.Thread):
    """Polls every node's full inventory and records the minimum replica count of tracked files.
    A node that cannot be reached (stopped / killed) keeps its last known inventory: its disk still
    holds those replicas."""

    def __init__(self, cl: Cluster, tracked: Iterable[str], interval: float = 0.3):
        super().__init__(daemon=True)
        self.cl = cl
        self.tracked: Set[str] = set(tracked)
        self.interval = interval
        self.last: Dict[str, Set[str]] = {}
        self.violations: List[Tuple[float, str, int]] = []
        self.samples = 0
        self.min_seen = 99
        self.lock = threading.Lock()
        self.stop_ev = threading.Event()

    def untrack(self, fid: str) -> None:
        with self.lock:
            self.tracked.discard(fid)

    def track(self, fid: str) -> None:
        with self.lock:
            self.tracked.add(fid)

    def run(self) -> None:
        while not self.stop_ev.is_set():
            for n in NODES:
                try:
                    self.last[n] = self.cl.inventory(n, timeout=3)
                except Exception:  # noqa: BLE001
                    pass
            if len(self.last) == len(NODES):
                with self.lock:
                    for f in self.tracked:
                        k = sum(1 for n in NODES if f in self.last[n])
                        self.min_seen = min(self.min_seen, k)
                        if k < 2:
                            self.violations.append((time.time(), f, k))
                    self.samples += 1
            self.stop_ev.wait(self.interval)

    def stop(self) -> None:
        self.stop_ev.set()
        self.join(10)


# ------------------------------------------------------------------------------------------ chaos helpers


def netem_on(node: str, peers: List[str]) -> str:
    """100 ms delay + 2 % loss on `node`'s egress, 2 % loss on its ingress (ifb). Falls back to shaping
    the peers' egress towards `node` when the kernel has no ifb support."""
    sh(node, "tc qdisc add dev eth0 root netem delay 100ms loss 2%")
    r = sh(
        node,
        "ip link add ifb0 type ifb && ip link set ifb0 up && tc qdisc add dev eth0 handle ffff: ingress && "
        "tc filter add dev eth0 parent ffff: protocol all u32 match u32 0 0 action mirred egress redirect dev ifb0 && "
        "tc qdisc add dev ifb0 root netem loss 2%",
        check_rc=False,
    )
    if r.returncode == 0:
        return "egress 100ms+2% loss, ingress 2% loss (ifb)"
    ip = node_ip(node)
    for p in peers:
        sh(
            p,
            "tc qdisc add dev eth0 root handle 1: prio bands 4 priomap 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 && "
            "tc qdisc add dev eth0 parent 1:4 handle 40: netem loss 2% && "
            f"tc filter add dev eth0 parent 1:0 protocol ip prio 1 u32 match ip dst {ip}/32 flowid 1:4",
        )
    return "egress 100ms+2% loss, peers' egress to it 2% loss (no ifb)"


def netem_off(node: str, peers: List[str]) -> None:
    sh(node, "tc qdisc del dev eth0 root; tc qdisc del dev eth0 ingress; ip link del ifb0", check_rc=False)
    for p in peers:
        sh(p, "tc qdisc del dev eth0 root", check_rc=False)


def partition(a: str, b: str, on: bool) -> None:
    ia, ib = node_ip(a), node_ip(b)
    op = "-I" if on else "-D"
    sh(a, f"iptables {op} INPUT -s {ib} -j DROP && iptables {op} OUTPUT -d {ib} -j DROP")
    sh(b, f"iptables {op} INPUT -s {ia} -j DROP && iptables {op} OUTPUT -d {ia} -j DROP")


# ------------------------------------------------------------------------------------------ scenarios


@dataclass
class Ctx:
    cl: Cluster
    files: List[TFile] = field(default_factory=list)
    unique: Dict[str, TFile] = field(default_factory=dict)  # sha -> file
    dups: Set[str] = field(default_factory=set)  # shas uploaded twice
    deleted: Set[str] = field(default_factory=set)
    extra: Dict[str, TFile] = field(default_factory=dict)  # files added by later scenarios
    gravity_subset: List[str] = field(default_factory=list)

    def live(self) -> Dict[str, TFile]:
        d = {k: v for k, v in self.unique.items() if k not in self.deleted}
        d.update({k: v for k, v in self.extra.items() if k not in self.deleted})
        return d

    def invs(self) -> Dict[str, Set[str]]:
        return {n: self.cl.inventory(n) for n in NODES}


def peers_ok(cl: Cluster, node: str, transport: Optional[str] = "quic") -> bool:
    s = cl.status(node)
    peers = [p for p in s["peers"] if not p["is_self"]]
    if len(peers) != 2 or not all(p["healthy"] for p in peers):
        return False
    return transport is None or all(p["transport"]["transport"] == transport for p in peers)


def all_converged(ctx: Ctx, transport: Optional[str] = "quic") -> bool:
    if not all(peers_ok(ctx.cl, n, transport) for n in NODES):
        return False
    invs = ctx.invs()
    return all(len(ctx.cl.holders(invs, f)) >= 2 for f in ctx.live())


def s1_health_quic(ctx: Ctx) -> str:
    cl = ctx.cl
    for n in NODES:
        h = cl.client(n).health()
        check(isinstance(h, dict), f"{n}: bad /health")
    dt = wait_until(lambda: all(peers_ok(cl, n) for n in NODES), 60, "all peers healthy over QUIC")
    parts = []
    for n in NODES:
        s = cl.status(n)
        t = s["transport"]
        check(s["cluster_size"] == 3 and s["min_replicas_effective"] == 2, f"{n}: cluster_size/min_replicas {s['cluster_size']}/{s['min_replicas_effective']}")
        check(t["https"]["requests"] == 0 and t["http"]["requests"] == 0, f"{n}: HTTP(S) peer requests {t['https']['requests']}/{t['http']['requests']}")
        check(t["fallbacks"] == 0, f"{n}: {t['fallbacks']} QUIC fallbacks")
        check(t["quic"]["requests"] > 0 and t["quic"]["errors"] == 0, f"{n}: quic requests/errors {t['quic']}")
        qs = s["quic_server"]
        check(qs is not None and qs["handshake_failures"] == 0 and qs["requests"] > 0, f"{n}: quic_server {qs}")
        for p in s["peers"]:
            if not p["is_self"]:
                check(p["transport"]["configured_transport"] == "quic", f"{n}: peer {p['url']} configured {p['transport']}")
        parts.append(f"{n} quic_req={t['quic']['requests']}")
    # mTLS probe from a separate container (curl with HTTP/3); optional when the image is unavailable
    probe = "skipped (alpine/curl-http3 unavailable)"
    base = ["docker", "run", "--rm", "--network", f"{PROJECT}_cluster", "-v", f"{PROJECT}_certs:/certs:ro", "alpine/curl-http3",
            "curl", "--http3-only", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "--cacert", "/certs/ca.pem"]
    try:
        no_cert = run(base + ["https://node-a:4433/health"], check_rc=False, timeout=180)
        with_cert = run(base + ["--cert", "/certs/node-c.pem", "--key", "/certs/node-c.key", "https://node-a:4433/health"], check_rc=False, timeout=180)
        if "Unable to find image" in no_cert.stderr and no_cert.returncode != 0 and not no_cert.stdout:
            pass
        elif with_cert.stdout.strip() == "200":
            check(no_cert.stdout.strip() != "200", "QUIC without client certificate was accepted (mTLS not enforced)")
            probe = "mTLS: no client cert refused, node cert -> 200"
        else:
            probe = f"skipped (curl http3 probe: rc={with_cert.returncode} {with_cert.stderr.strip()[:80]})"
    except (subprocess.TimeoutExpired, RuntimeError) as e:
        probe = f"skipped ({e})"
    return f"peers healthy+QUIC after {dt:.1f}s; 0 HTTPS requests, 0 fallbacks; {', '.join(parts)}; {probe}"


def s2_write_read(ctx: Ctx) -> str:
    cl = ctx.cl
    ctx.files = make_dataset()
    a = cl.client("node-a")
    total = 0
    up = 0.0
    dedup_chunks = dups = 0
    for f in ctx.files:
        body = gen(f)
        t0 = time.perf_counter()
        r = a.store_put(body, content_type=f.ctype)
        up += time.perf_counter() - t0
        check(r.file_id == f.sha, f"{f.name}: file_id {r.file_id} != sha256 {f.sha}")
        check(r.size == f.size, f"{f.name}: size {r.size}")
        if f.sha in ctx.unique:
            check(r.duplicate and r.pins == 2, f"{f.name}: duplicate={r.duplicate} pins={r.pins}")
            ctx.dups.add(f.sha)
            dups += 1
        else:
            ctx.unique[f.sha] = f
        dedup_chunks += r.dedup_chunks if not r.duplicate else 0
        total += f.size
    check(dedup_chunks > 0, "no chunk-level dedup across shared-region files")
    ids = set(ctx.unique)
    rep = wait_until(lambda: ids <= cl.inventory("node-a") and ids <= cl.inventory("node-b"), 300, "repair copies on node-b")
    check(not (ids & cl.inventory("node-c")), "node-c already holds files (expected node-b as repair target)")
    st = cl.stats("node-a")
    # remote reads from node-c: every file once, full + byte-exact
    t1 = time.perf_counter()
    rbytes = 0
    for f in ctx.unique.values():
        n, _, _ = cl.read_verify("node-c", f, expect_remote=True)
        rbytes += n
    rd = time.perf_counter() - t1
    # range reads (at most one per file so no file reaches the gravity threshold of 3 here)
    rr = random.Random(7)
    ranged = 0
    big = [f for f in ctx.unique.values() if f.size > MiB]
    for f in big[:10]:
        s = rr.randrange(0, f.size - 1)
        e = min(f.size - 1, s + rr.randrange(1, 3 * MiB))
        cl.read_verify("node-c", f, (s, e), expect_remote=True)
        ranged += 1
    for f in big[10:15]:
        cl.read_verify("node-c", f, -4096, expect_remote=True)
        ranged += 1
    f0 = big[0]
    try:
        cl.client("node-c").store_get(f0.sha, range=(f0.size + 10, f0.size + 20))
        raise Fail("unsatisfiable range did not return 416")
    except RangeNotSatisfiableError:
        pass
    m = cl.metrics("node-c")
    check(m["remote_reads"] >= len(ctx.unique) + ranged, f"node-c remote_reads={m['remote_reads']}")
    return (
        f"{len(ctx.files)} files ({len(ctx.unique)} unique, {dups} dup) {total / MiB:.0f} MiB -> node-a in {up:.1f}s "
        f"({total / MiB / up:.0f} MiB/s); dedup ratio {st['dedup_ratio']:.2f}; repair to node-b {rep:.1f}s; "
        f"node-c remote full reads {rbytes / MiB:.0f} MiB in {rd:.1f}s ({rbytes / MiB / rd:.1f} MiB/s), "
        f"{ranged} range reads + 416 OK, all SHA-256 exact"
    )


def s3_gravity(ctx: Ctx) -> str:
    cl = ctx.cl
    invs = ctx.invs()
    cands = sorted(
        (f for f in ctx.unique.values() if f.sha not in invs["node-c"] and f.sha not in ctx.dups and 64 * KiB <= f.size <= 16 * MiB),
        key=lambda f: f.size,
    )
    subset = [cands[i] for i in range(0, len(cands), max(1, len(cands) // 6))][:6]
    ctx.gravity_subset = [f.sha for f in subset]
    before = {n: cl.metrics(n) for n in NODES}
    mon = HolderMonitor(cl, ctx.live())
    mon.start()
    try:
        for f in subset:
            for _ in range(4):
                cl.read_verify("node-c", f)
        ids = set(ctx.gravity_subset)
        pull_t = wait_until(lambda: ids <= cl.inventory("node-c"), 120, "gravity pulls on node-c")
        drop_t = wait_until(lambda: all(len(cl.holders(ctx.invs(), f)) == 2 for f in ids), 90, "gravity drops back to 2 holders")
        time.sleep(3)
    finally:
        mon.stop()
    after = {n: cl.metrics(n) for n in NODES}
    d = {n: {k: after[n][k] - before[n][k] for k in ("pulls", "drops", "origin_transfers", "leases_granted")} for n in NODES}
    drops = sum(d[n]["drops"] for n in NODES)
    leases = sum(d[n]["leases_granted"] for n in NODES)
    invs = ctx.invs()
    check(d["node-c"]["pulls"] >= len(subset), f"node-c pulls {d['node-c']['pulls']} < {len(subset)}")
    check(d["node-c"]["drops"] == 0, "node-c (the demanding node) dropped replicas")
    check(drops >= len(subset), f"only {drops} drops for {len(subset)} pulled files")
    check(leases >= 2 * drops, f"{leases} leases granted for {drops} drops (need 2 per drop)")
    check(not mon.violations, f"replica count < 2 observed: {mon.violations[:3]}")
    check(all("node-c" in cl.holders(invs, f) for f in ids), "a pulled replica disappeared from node-c")
    for f in subset:
        cl.read_verify("node-a", f)
    who = ", ".join(f"{n}: pulls {d[n]['pulls']} drops {d[n]['drops']} origin_xfer {d[n]['origin_transfers']} leases_granted {d[n]['leases_granted']}" for n in NODES)
    return (
        f"{len(subset)} files hammered (4 reads each) on node-c; pulled in {pull_t:.1f}s; dropped back to 2 holders in "
        f"{drop_t:.1f}s; {drops} drops / {leases} leases; min holders seen {mon.min_seen} over {mon.samples} polls; {who}"
    )


def s4_failure(ctx: Ctx) -> str:
    cl = ctx.cl
    live = ctx.live()
    invs = ctx.invs()
    need = {f for f in live if len([n for n in cl.holders(invs, f) if n != "node-b"]) == 1}
    # files to delete during the outage: held by a (origin) and b, single pin, not gravity files
    deletable = [f for f in live if set(cl.holders(invs, f)) == {"node-a", "node-b"} and f not in ctx.dups
                 and f not in ctx.gravity_subset and live[f].size <= 4 * MiB]
    dels = deletable[:3]
    check(len(dels) == 3, "not enough deletable files")
    before = {n: cl.metrics(n) for n in ("node-a", "node-c")}
    mon = HolderMonitor(cl, [f for f in live if f not in dels])
    mon.start()
    out = []
    try:
        t0 = time.perf_counter()
        compose("stop", "node-b")
        stop_t = time.perf_counter() - t0
        for f in dels:
            r = cl.client("node-a").store_delete(f)
            check(r.deleted, f"delete {f[:12]} on node-a: {r}")
            ctx.deleted.add(f)
        expected = need - set(dels)
        rep_t = wait_until(
            lambda: all(f in cl.inventory("node-a") and f in cl.inventory("node-c") for f in expected), 300,
            f"repair of {len(expected)} files on node-a/node-c",
        )
        time.sleep(4)  # several more maintenance rounds: no duplicate pulls must follow
        after = {n: cl.metrics(n) for n in ("node-a", "node-c")}
        rep = {n: after[n]["repairs"] - before[n]["repairs"] for n in after}
        check(sum(rep.values()) == len(expected), f"repairs {rep} for {len(expected)} under-replicated files (stampede or miss)")
        for f in dels:
            for n in ("node-a", "node-c"):
                check(f not in cl.inventory(n), f"deleted file still on {n}")
        out.append(f"graceful stop {stop_t:.1f}s; {len(expected)} under-replicated files repaired in {rep_t:.1f}s with "
                   f"pulls a={rep['node-a']} c={rep['node-c']} (no duplicates); 3 deletes during outage")
        # restart: catch up via inventory gossip, tombstones beat the stale replicas
        t0 = time.perf_counter()
        compose("start", "node-b")
        up_t = wait_until(lambda: peers_ok(cl, "node-b", None) and not (set(dels) & cl.inventory("node-b")), 120, "node-b catch-up")
        time.sleep(4)
        for f in dels:
            for n in NODES:
                check(f not in cl.inventory(n), f"resurrected: {f[:12]} on {n}")
                try:
                    cl.client(n, 30, 0).store_head(f)
                    raise Fail(f"deleted file {f[:12]} still readable on {n}")
                except NotFoundError:
                    pass
        tb = cl.metrics("node-b")["tombstones_applied"]
        check(tb >= len(dels), f"node-b applied {tb} tombstones")
        out.append(f"node-b restart+catch-up {up_t:.1f}s, {tb} tombstones applied, no resurrection")
        # hard kill during an upload
        big = TFile("killed-upload", "random", 48 * MiB, 900)
        data = gen(big)
        err: List[BaseException] = []

        def slow_chunks() -> Iterable[bytes]:
            for i in range(0, len(data), MiB):
                time.sleep(0.05)
                yield data[i : i + MiB]

        def upload() -> None:
            try:
                cl.client("node-b", 60, 0).store_put(slow_chunks())
            except BaseException as e:  # noqa: BLE001
                err.append(e)

        th = threading.Thread(target=upload, daemon=True)
        th.start()
        time.sleep(1.0)
        compose("kill", "node-b")
        th.join(60)
        compose("start", "node-b")
        kill_t = wait_until(lambda: peers_ok(cl, "node-b", None), 120, "node-b back after SIGKILL")
        binv = cl.inventory("node-b")
        partial_present = hashlib.sha256(data).hexdigest() in binv
        nread = 0
        for f in binv:
            tf = ctx.live().get(f)
            if tf is not None:
                cl.read_verify("node-b", tf, expect_remote=False)
                nread += 1
        st = cl.stats("node-b")
        check(st["files"] == len(binv), f"node-b stats files {st['files']} != inventory {len(binv)}")
        out.append(f"SIGKILL mid-upload ({'upload failed' if err else 'upload finished first'}; partial file present={partial_present}); "
                   f"back in {kill_t:.1f}s, {nread} local files byte-exact")
        wait_until(lambda: all_converged(ctx, None), 120, "convergence after restart")
    finally:
        mon.stop()
    check(not mon.violations, f"replica count < 2 observed (counting the stopped node's disk): {mon.violations[:3]}")
    out.append(f"min holders {mon.min_seen} over {mon.samples} polls")
    return "; ".join(out)


def _fresh(ctx: Ctx, name: str, size: int, seed: int) -> TFile:
    f = TFile(name, "random", size, seed)
    f.sha = hashlib.sha256(gen(f)).hexdigest()
    r = ctx.cl.client("node-a").store_put(gen(f))
    check(r.file_id == f.sha, f"{name}: bad file id")
    ctx.extra[f.sha] = f
    wait_until(lambda: f.sha in ctx.cl.inventory("node-b"), 120, f"{name} replicated to node-b")
    return f


def _measure(ctx: Ctx, label: str, seed: int) -> Tuple[float, float]:
    cl = ctx.cl
    f1 = _fresh(ctx, f"rr-{label}", 4 * MiB, seed)
    n, remote, dt = cl.read_verify("node-c", f1, expect_remote=True)
    rr = n / MiB / dt
    f2 = _fresh(ctx, f"pull-{label}", 16 * MiB, seed + 1)
    t0 = time.perf_counter()
    for _ in range(3):
        cl.read_verify("node-c", f2, (0, 0))
    try:
        wait_until(lambda: f2.sha in cl.inventory("node-c"), 600, f"gravity pull {label}", interval=0.2)
    except Fail as e:
        s = cl.status("node-c")
        m = s["metrics"]
        diag = {k: m[k] for k in ("pulls", "pull_failures", "remote_fetch_failures", "remote_objects_fetched", "remote_reads")}
        dem = next((d["score"] for d in s["demand_top"] if d["file_id"] == f2.sha), None)
        raise Fail(f"{e}; node-c {diag}, demand for the file {dem}, transport {s['transport']['https']} / {s['transport']['quic']}") from e
    pull = f2.size / MiB / (time.perf_counter() - t0)
    cl.read_verify("node-c", f2, expect_remote=False)
    log(f"  {label}: remote read {rr:.2f} MiB/s ({dt:.1f}s for 4 MiB), gravity pull {pull:.2f} MiB/s")
    return rr, pull


def _recreate_c(ctx: Ctx, https: bool) -> None:
    env = {"NODE_C_PEERS": HTTPS_PEERS_C} if https else {}
    compose("up", "-d", "--no-deps", "--wait", "node-c", env=env, timeout=300)
    wait_until(lambda: peers_ok(ctx.cl, "node-c", "https" if https else "quic"), 90, f"node-c peers over {'https' if https else 'quic'}")


def s5_netem(ctx: Ctx) -> str:
    cl = ctx.cl
    res = {}
    res["quic clean"] = _measure(ctx, "quic-clean", 1000)
    mode = netem_on("node-c", ["node-a", "node-b"])
    try:
        rtt = sh("node-c", "t0=$(date +%s%N); curl -s -o /dev/null --cacert /certs/ca.pem https://node-a:4433/health; t1=$(date +%s%N); echo $(( (t1-t0)/1000000 ))").stdout.strip()
        res["quic netem"] = _measure(ctx, "quic-netem", 1010)
        invs = ctx.invs()
        sample = [f for f in ctx.live().values() if f.sha not in invs["node-c"] and f.size <= 2 * MiB][:5]
        if len(sample) < 3:  # node-c may hold everything after the failure scenario's repairs
            sample = [_fresh(ctx, f"netem-{i}", 512 * KiB + i, 1050 + i) for i in range(3)]
        for f in sample:
            cl.read_verify("node-c", f, expect_remote=True)
    finally:
        netem_off("node-c", ["node-a", "node-b"])
    _recreate_c(ctx, https=True)
    try:
        netem_on("node-c", ["node-a", "node-b"])
        try:
            res["https netem"] = _measure(ctx, "https-netem", 1020)
        finally:
            netem_off("node-c", ["node-a", "node-b"])
        res["https clean"] = _measure(ctx, "https-clean", 1030)
        t = cl.status("node-c")["transport"]
        check(t["https"]["requests"] > 0, "node-c used no HTTPS in forced-HTTPS mode")
    finally:
        _recreate_c(ctx, https=False)
    table = "; ".join(f"{k}: read {v[0]:.2f} / pull {v[1]:.2f} MiB/s" for k, v in res.items())
    return f"netem on node-c ({mode}; curl /health on a new TCP+TLS connection {rtt} ms); {len(sample)} more remote reads exact under netem; {table}"


def s6_partition(ctx: Ctx) -> str:
    cl = ctx.cl
    partition("node-a", "node-c", True)
    healed = False
    try:
        t_detect = wait_until(
            lambda: not next(p for p in cl.status("node-c")["peers"] if "node-a" in p["url"])["healthy"]
            and not next(p for p in cl.status("node-a")["peers"] if "node-c" in p["url"])["healthy"],
            60, "a<->c partition detected",
        )
        invs = ctx.invs()
        via_b = [f for f in ctx.live().values() if set(cl.holders(invs, f.sha)) == {"node-a", "node-b"} and f.size <= 8 * MiB][:5]
        check(len(via_b) >= 3, f"only {len(via_b)} files held by exactly a+b")
        times = []
        n_remote = 0
        time.sleep(5)  # past the 3 x gossip-interval health window: node-b must still be healthy
        # With node-a unhealthy, node-c may already have repaired a file from node-b (local read);
        # either way the bytes can only have come from node-b.
        for f in via_b:
            _, remote, dt = cl.read_verify("node-c", f)
            times.append(dt)
            n_remote += remote
        b_ok = next(p for p in cl.status("node-c")["peers"] if "node-b" in p["url"])["healthy"]
        check(b_ok, "node-c marks node-b unhealthy while only node-a is partitioned")
        check(max(times) < 10, f"reads via node-b too slow ({max(times):.1f}s): the partitioned node was tried first")
        new_a = [_new_upload(ctx, "node-a", f"part-a-{i}", 1100 + i) for i in range(2)]
        new_c = [_new_upload(ctx, "node-c", f"part-c-{i}", 1200 + i) for i in range(2)]
        partition("node-a", "node-c", False)
        healed = True
        conv = wait_until(lambda: all_converged(ctx, None), 180, "convergence after heal")
        for f in new_c:
            cl.read_verify("node-a", f)
        for f in new_a:
            cl.read_verify("node-c", f)
        quic_t = wait_until(lambda: all(peers_ok(cl, n, "quic") for n in NODES), 180, "QUIC transport restored a<->c")
    finally:
        if not healed:
            partition("node-a", "node-c", False)
    return (
        f"iptables a<->c; detected in {t_detect:.1f}s; node-b stays healthy; {len(via_b)} a+b-only files read on node-c exact "
        f"({n_remote} remote via node-b, {len(via_b) - n_remote} already repaired from node-b; max {max(times):.2f}s); 4 uploads during partition; heal -> converged (all files >=2 holders, all peers healthy) "
        f"in {conv:.1f}s; QUIC (after fallback window) back in {quic_t:.1f}s more"
    )


def _new_upload(ctx: Ctx, node: str, name: str, seed: int) -> TFile:
    f = TFile(name, "random", 1 * MiB + seed, seed)
    f.sha = hashlib.sha256(gen(f)).hexdigest()
    r = ctx.cl.client(node).store_put(gen(f))
    check(r.file_id == f.sha, f"{name}: bad id")
    ctx.extra[f.sha] = f
    return f


def s7_corruption(ctx: Ctx) -> str:
    cl = ctx.cl
    paths = sh("node-b", "find /data/reactor-state/store/objects -name '*.obj' -size +64k | head -n 2").stdout.split()
    check(len(paths) == 2, f"found {len(paths)} object files on node-b")
    s0 = cl.stats("node-b")["scrub"]
    m0 = cl.metrics("node-b")
    for p in paths:
        sh("node-b", f"sz=$(stat -c %s {p}); printf '\\377\\376\\375\\374\\373\\372\\371\\370' | dd of={p} bs=1 seek=$((sz/2)) count=8 conv=notrunc 2>/dev/null")
    t0 = time.perf_counter()
    det = wait_until(lambda: cl.stats("node-b")["scrub"]["corrupt_found"] >= s0["corrupt_found"] + 2, 120, "scrub detects corruption")
    fix = wait_until(lambda: cl.metrics("node-b")["quarantine_repairs"] >= m0["quarantine_repairs"] + 2, 120, "quarantine repaired from a peer")
    total = time.perf_counter() - t0
    m1 = cl.metrics("node-b")
    binv = cl.inventory("node-b")
    n = 0
    for f in binv:
        tf = ctx.live().get(f)
        if tf:
            cl.read_verify("node-b", tf, expect_remote=False)
            n += 1
    s1 = cl.stats("node-b")["scrub"]
    return (
        f"2 object files on node-b corrupted (8 bytes each); scrub quarantined in {det:.1f}s, repaired from peer "
        f"{total:.1f}s after corruption (repair failures +{m1['quarantine_repair_failures'] - m0['quarantine_repair_failures']}); "
        f"{n} files on node-b byte-exact; scrub quarantined now {s1['quarantined']}"
    )


def s8_backup_restore(ctx: Ctx) -> str:
    cl = ctx.cl
    dest = f"ct-{int(time.time())}"
    a = cl.client("node-a")
    wait_until(lambda: all_converged(ctx, None), 120, "convergence before backup")
    before = cl.inventory("node-a")
    t0 = time.perf_counter()
    rep = a._json("POST", "/store/backup", json.dumps({"dest": dest}).encode(), {"content-type": "application/json"})
    bk = time.perf_counter() - t0
    # files held for the whole backup run must be in it (one arriving / leaving mid-run may or may not be)
    a_files = before & cl.inventory("node-a")
    node_id = cl.status("node-a")["node_id"]
    compose("stop", "node-a")
    left = compose("run", "--rm", "--no-deps", "-u", "0", "--entrypoint", "sh", "node-a", "-c",
                   "rm -rf /data/reactor-state/* /data/reactor-state/.[!.]* ; ls -A /data/reactor-state | wc -l").stdout.strip().splitlines()[-1]
    check(left.strip() == "0", f"wipe left {left} entries")
    t1 = time.perf_counter()
    out = compose("run", "--rm", "--no-deps", "--entrypoint", "reactor-admin", "node-a", "restore", f"/backups/{dest}", "/data/reactor-state", timeout=1800)
    rs = time.perf_counter() - t1
    restore_line = next((l for l in out.stdout.splitlines() if "restore: OK" in l), out.stdout.strip().splitlines()[-1])
    compose("start", "node-a")
    wait_until(lambda: peers_ok(cl, "node-a", None), 120, "node-a back after restore")
    check(cl.status("node-a")["node_id"] == node_id, "node_id changed by restore")
    inv = cl.inventory("node-a")
    check(a_files <= inv, f"{len(a_files - inv)} files missing after restore: {[f[:12] for f in a_files - inv]}")
    n = 0
    for f in a_files:
        tf = ctx.live().get(f)
        if tf:
            cl.read_verify("node-a", tf, expect_remote=False)
            n += 1
    files = rep.get("files", rep.get("files_copied", "?")) if isinstance(rep, dict) else "?"
    return (f"online backup {bk:.1f}s (report files={files}); node-a stopped, volume wiped, reactor-admin restore "
            f"{rs:.1f}s ({restore_line.strip()}); same node_id; {n}/{len(a_files)} files read locally byte-exact")


def s9_encryption(ctx: Ctx) -> str:
    cl = ctx.cl
    mf = next(f for f in ctx.unique.values() if f.kind == "marker" and f.size >= 64 * KiB)
    blob = cl.client("node-a").compress(gen(mf)[: 256 * KiB], no_sample=True).data or b""
    control = MARKER in blob
    check(control, "control failed: marker not visible in a compressed (unencrypted) blob, test would prove nothing")
    stored = []
    for n in NODES:
        inv = cl.inventory(n)
        k = sum(1 for f in ctx.live().values() if f.kind in ("marker", "text") and f.sha in inv)
        stored.append(f"{n}:{k}")
        enc = cl.stats(n).get("encryption", {})
        check(enc.get("enabled") is True and enc.get("plaintext_objects", 1) == 0, f"{n}: encryption stats {enc}")
        r = sh(n, f"grep -rlaF '{MARKER.decode()}' /data/reactor-state; echo rc=$?", check_rc=False)
        check("rc=1" in r.stdout, f"{n}: plaintext marker found in volume: {r.stdout.strip()[:300]}")
    r = sh("node-a", f"grep -rlaF '{MARKER.decode()}' /backups; echo rc=$?", check_rc=False)
    check("rc=1" in r.stdout, f"backup volume holds plaintext: {r.stdout.strip()[:300]}")
    return (f"control: marker visible in compressed blob ({len(blob)} B) -> only encryption can hide it; marker files held "
            f"({', '.join(stored)}); grep of all 3 volumes + backup volume: not found; plaintext_objects=0 on every node")


SCENARIOS = [
    ("1 health + QUIC", s1_health_quic),
    ("2 write 50 / remote read", s2_write_read),
    ("3 gravity pull/drop", s3_gravity),
    ("4 node failure + repair", s4_failure),
    ("5 netem QUIC vs HTTPS", s5_netem),
    ("6 partition + heal", s6_partition),
    ("7 corruption + scrub", s7_corruption),
    ("8 backup / restore", s8_backup_restore),
    ("9 encryption at rest", s9_encryption),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-build", action="store_true", help="use the existing images")
    ap.add_argument("--keep", action="store_true", help="leave the cluster running afterwards")
    ap.add_argument("--only", default="", help="comma-separated scenario numbers (2 always runs when a later one is chosen)")
    ap.add_argument("--rmi", action="store_true", help="also remove the test images afterwards")
    args = ap.parse_args()
    only = {int(x) for x in args.only.split(",") if x.strip()}
    if only and max(only) > 2:
        only |= {1, 2}

    work = Path(tempfile.mkdtemp(prefix="datran-ct-"))
    results: List[Tuple[str, bool, float, str]] = []
    try:
        log("resetting any previous test cluster")
        compose("down", "-v", "--remove-orphans", check_rc=False)
        log("building images + starting node-a/b/c" + (" (no build)" if args.no_build else ""))
        t0 = time.perf_counter()
        compose("up", "-d", "--wait", *([] if args.no_build else ["--build"]), timeout=3600)
        log(f"cluster up in {time.perf_counter() - t0:.0f}s")
        compose("cp", "node-a:/certs/ca.pem", str(work / "ca.pem"))
        ctx = Ctx(Cluster(str(work / "ca.pem")))
        for name, fn in SCENARIOS:
            num = int(name.split()[0])
            if only and num not in only:
                continue
            log(f"=== scenario {name}")
            t = time.perf_counter()
            try:
                detail = fn(ctx)
                ok = True
            except Exception as e:  # noqa: BLE001
                ok = False
                detail = f"{type(e).__name__}: {e}"
                if not isinstance(e, Fail):
                    traceback.print_exc()
            dt = time.perf_counter() - t
            results.append((name, ok, dt, detail))
            log(f"{'PASS' if ok else 'FAIL'} {name} ({dt:.0f}s): {detail}")
            if not ok and num <= 2:
                log("stopping: later scenarios need the data set")
                break
    finally:
        if any(not r[1] for r in results):
            try:
                logs = compose("logs", "--no-color", "--tail", "60", check_rc=False).stdout
                (work / "compose-logs.txt").write_text(logs, encoding="utf-8")
                print(logs[-6000:])
            except Exception:  # noqa: BLE001
                pass
        if not args.keep:
            log("tearing down (containers, network, volumes)")
            compose("down", "-v", "--remove-orphans", *(["--rmi", "local"] if args.rmi else []), check_rc=False)
        shutil.rmtree(work, ignore_errors=True)

    print("\n" + "=" * 100)
    print(f"{'scenario':<28} {'result':<6} {'time':>6}  details")
    print("-" * 100)
    for name, ok, dt, detail in results:
        print(f"{name:<28} {'PASS' if ok else 'FAIL':<6} {dt:>5.0f}s  {detail}")
    print("=" * 100)
    failed = [r for r in results if not r[1]]
    expected = len(only) if only else len(SCENARIOS)
    if len(results) < expected:
        print(f"{expected - len(results)} scenario(s) not run")
    print("RESULT:", "PASS" if results and not failed and len(results) == expected else "FAIL")
    return 0 if results and not failed and len(results) == expected else 1


if __name__ == "__main__":
    sys.exit(main())
