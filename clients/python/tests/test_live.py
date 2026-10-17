"""Tests against a live reactor (see reactor_harness.py)."""

from __future__ import annotations

import hashlib
import io
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from datran_client import (  # noqa: E402
    AuthError,
    BadRequestError,
    Client,
    ClusterAdmin,
    ClusterStatus,
    NotFoundError,
    RangeNotSatisfiableError,
    ServerError,
    StoreStats,
)
from reactor_harness import reactor, start_cluster  # noqa: E402


def sample_text(n_lines: int = 5000) -> bytes:
    return "".join(f'{{"id":{i},"name":"user{i}","ok":{str(i % 3 == 0).lower()}}}\n' for i in range(n_lines)).encode()


class DataPlaneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, token = reactor()
        cls.c = Client(url, token, 30)
        cls.url, cls.token = url, token

    def test_health(self):
        h = self.c.health()
        self.assertEqual(h["status"], "online")
        self.assertIn("features", h)

    def test_compress_roundtrip_bytes(self):
        data = sample_text()
        r = self.c.compress(data, content_type="application/json")
        self.assertEqual(r.original_size, len(data))
        self.assertEqual(r.compressed_size, len(r.data))
        self.assertLess(r.compressed_size, len(data))
        self.assertEqual(r.format, "v2")
        self.assertIsInstance(r.recipe, dict)
        self.assertIn("codec", r.recipe)
        self.assertTrue(r.content_class)
        self.assertGreater(r.ratio, 1.0)
        self.assertEqual(self.c.decompress(r.data), data)

    def test_compress_streaming(self):
        data = sample_text(20000)
        out = io.BytesIO()
        r = self.c.compress_to(io.BytesIO(data), out, no_sample=True)
        self.assertIsNone(r.data)
        self.assertEqual(r.compressed_size, len(out.getvalue()))
        # chunked request body (iterable) + streamed response into a file
        with tempfile.TemporaryFile() as f:
            n = self.c.decompress_to(iter([out.getvalue()[:100], out.getvalue()[100:]]), f)
            self.assertEqual(n, len(data))
            f.seek(0)
            self.assertEqual(f.read(), data)

    def test_compress_empty_and_random(self):
        r = self.c.compress(b"")
        self.assertEqual(self.c.decompress(r.data), b"")
        rnd = os.urandom(50_000)
        r = self.c.compress(rnd)
        self.assertEqual(r.content_class, "media/compressed")
        self.assertIsNone(r.recipe)
        self.assertEqual(r.format, "legacy-raw")
        self.assertEqual(self.c.decompress(r.data), rnd)

    def test_decompress_garbage(self):
        with self.assertRaises(BadRequestError) as cm:
            self.c.decompress(b"\x67garbage")
        self.assertEqual(cm.exception.status, 400)
        self.assertIn("flag", cm.exception.message.lower())

    def test_entropy(self):
        e = self.c.entropy(b"hello")
        self.assertEqual(e.size_bytes, 5)
        self.assertAlmostEqual(e.entropy_bits, 1.92, places=2)
        self.assertEqual(e.suggested_routing, "symbit")

    def test_evolution_status(self):
        self.c.compress(sample_text(100), content_type="application/json")
        s = self.c.evolution_status()
        for k in ("enabled", "interval_ms", "weights", "classes"):
            self.assertIn(k, s)
        self.assertIsInstance(s["classes"], list)

    def test_bad_token(self):
        if not self.token:
            self.skipTest("reactor runs without a token")
        bad = Client(self.url, "wrong-token", 10)
        with self.assertRaises(AuthError) as cm:
            bad.entropy(b"x")
        self.assertEqual(cm.exception.status, 401)
        self.assertEqual(bad.health()["status"], "online")  # health needs no token


class StoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        url, token = reactor()
        cls.c = Client(url, token, 60)
        try:
            cls.c.store_stats()
        except NotFoundError:
            raise unittest.SkipTest("store not available on this reactor (/store/stats -> 404)")
        except ServerError as e:
            if e.status != 503:
                raise
            raise unittest.SkipTest("object store disabled on this reactor (/store/stats -> 503)")

    def test_put_get_range_delete(self):
        data = sample_text(30000) + os.urandom(100_000)
        fid = hashlib.sha256(data).hexdigest()
        put = self.c.store_put(io.BytesIO(data), content_type="application/json")
        self.assertEqual(put.file_id, fid)
        self.assertEqual(put.size, len(data))
        self.assertFalse(put.duplicate)
        self.assertEqual(put.pins, 1)
        self.assertGreater(put.chunks, 0)
        self.assertEqual(put.new_chunks + put.dedup_chunks, put.chunks)
        self.assertGreater(put.stored_bytes, 0)
        self.assertTrue(0 < put.new_bytes <= put.size)
        self.assertTrue(put.content_class)
        try:
            full = self.c.store_get(fid)
            self.assertEqual(full.data, data)
            self.assertEqual(full.etag, f'"{fid}"')
            h = self.c.store_head(fid)
            self.assertEqual(h.size, len(data))
            self.assertEqual(h.accept_ranges, "bytes")
            self.assertEqual(h.etag, f'"{fid}"')
            self.assertTrue(self.c.store_exists(fid.upper()))  # ids are case-insensitive

            g = self.c.store_get(fid, range=(1000, 1999))
            self.assertEqual(g.status, 206)
            self.assertEqual(g.data, data[1000:2000])
            self.assertEqual((g.start, g.end, g.total), (1000, 1999, len(data)))
            self.assertEqual(self.c.store_get_bytes(fid, range=-777), data[-777:])
            self.assertEqual(self.c.store_get_bytes(fid, range=(len(data) - 10, None)), data[-10:])
            multi = self.c.store_get(fid, range="bytes=0-1,4-5")  # multi-range -> whole file
            self.assertEqual((multi.status, multi.data), (200, data))
            with self.assertRaises(RangeNotSatisfiableError) as cm:
                self.c.store_get(fid, range=(len(data) + 10, None))
            self.assertEqual(cm.exception.status, 416)
            self.assertEqual(cm.exception.size, len(data))

            with tempfile.TemporaryFile() as f:
                res = self.c.store_get_to(fid, f)
                self.assertEqual(res.length, len(data))
                f.seek(0)
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), fid)
        finally:
            d = self.c.store_delete(fid)
        self.assertEqual((d.file_id, d.pins, d.deleted), (fid, 0, True))
        with self.assertRaises(NotFoundError):
            self.c.store_get_bytes(fid)
        self.assertFalse(self.c.store_exists(fid))
        with self.assertRaises(NotFoundError):
            self.c.store_delete(fid)

    def test_put_from_path_chunked_and_dedup(self):
        # a per-run tag on every line keeps every chunk unique, so the first put stores all of it
        data = sample_text(8000).replace(b'"user', f'"{os.urandom(4).hex()}-user'.encode())
        fid = hashlib.sha256(data).hexdigest()
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
            path = f.name
        try:
            a = self.c.store_put(path)
            b = self.c.store_put(iter([data[:5000], data[5000:]]))  # chunked transfer
            self.assertEqual(a.file_id, fid)
            self.assertEqual(b.file_id, fid)
            self.assertEqual(b.new_chunks, 0)
            self.assertGreater(b.dedup_chunks, 0)
            self.assertEqual(b.dedup_chunks, b.chunks)
            self.assertTrue(b.duplicate)
            self.assertEqual((a.pins, b.pins), (1, 2))
            # new_bytes: plaintext of newly stored chunks; compression = new_bytes / stored_bytes
            self.assertEqual((a.new_chunks, a.new_bytes), (a.chunks, len(data)))
            self.assertGreater(a.new_bytes, a.stored_bytes)  # JSON lines compress
            self.assertEqual((b.new_bytes, b.stored_bytes), (0, 0))
            d1 = self.c.store_delete(fid)  # one pin left
            self.assertEqual((d1.pins, d1.deleted), (1, False))
            self.assertEqual(self.c.store_get_bytes(fid), data)
            d2 = self.c.store_delete(fid)
            self.assertEqual((d2.pins, d2.deleted), (0, True))
            with self.assertRaises(NotFoundError):
                self.c.store_head(fid)
        finally:
            os.unlink(path)

    def test_stats_and_unknown(self):
        before = self.c.store_stats()
        self.assertIsInstance(before, StoreStats)
        data = sample_text(3000)
        put = self.c.store_put(data)
        try:
            s = self.c.store_stats()
            self.assertGreaterEqual(s.files, 1)
            self.assertGreaterEqual(s.puts, before.puts + 1)
            self.assertGreaterEqual(s.logical_bytes, len(data))
            self.assertGreater(s.unique_bytes, 0)
            self.assertGreater(s.live_physical_bytes, 0)
            self.assertIsNone(s.max_bytes)
            self.assertGreaterEqual(s.dedup_ratio, 1.0)
            self.assertGreater(s.total_ratio, 0.0)
            self.assertGreater(s.chunks, 0)
            self.assertGreater(s.gc.grace_ms, 0)
            self.assertIsInstance(s.fusion.enabled, bool)
            self.assertIsInstance(s.fusion.coaccess_min, float)
            self.assertGreaterEqual(s.scrub.quarantined, 0)
            self.assertIsNotNone(s.group_commit)
            self.assertGreaterEqual(s.group_commit.jobs, 1)
            self.assertIsNone(s.cluster)  # single reactor without REACTOR_CLUSTER_TOKEN
            # cluster status needs data gravity (store + cluster token): 503 otherwise
            with self.assertRaises(ServerError) as cm:
                Client(self.c.base_url, self.c.token, 10, max_retries=0).cluster_status()
            self.assertEqual(cm.exception.status, 503)
        finally:
            self.c.store_delete(put.file_id)
        with self.assertRaises(NotFoundError):
            self.c.store_get_bytes("0" * 64)
        with self.assertRaises(BadRequestError):
            self.c.store_get_bytes("not-a-sha256")


def _wait(pred, timeout=15.0, step=0.1):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = pred()
        if last:
            return last
        time.sleep(step)
    return last


class ClusterTests(unittest.TestCase):
    """Two reactors with data gravity (REACTOR_PEERS + REACTOR_CLUSTER_TOKEN)."""

    @classmethod
    def setUpClass(cls):
        cls.cl = start_cluster(2, gossip_ms=200)
        cls.a = Client(cls.cl.urls[0], cls.cl.token, 30)
        cls.b = Client(cls.cl.urls[1], cls.cl.token, 30)

    @classmethod
    def tearDownClass(cls):
        cls.cl.stop()

    def _healthy(self, c: Client, peer_id: str):
        s = c.cluster_status()
        p = s.peer(peer_id)
        return s if p is not None and p.healthy else None

    def test_status_put_on_a_read_via_b_delete_via_b(self):
        a_id = self.a.cluster_status().node_id
        b_id = self.b.cluster_status().node_id
        self.assertNotEqual(a_id, b_id)
        sa = _wait(lambda: self._healthy(self.a, b_id))
        sb = _wait(lambda: self._healthy(self.b, a_id))
        self.assertIsInstance(sa, ClusterStatus, "A never saw B healthy")
        self.assertIsInstance(sb, ClusterStatus, "B never saw A healthy")
        self.assertEqual((sa.cluster_size, sa.min_replicas, sa.min_replicas_effective), (2, 1, 1))
        self.assertEqual(sa.gossip_interval_ms, 200)
        pb = sa.peer(b_id)
        self.assertEqual(pb.url, self.cl.urls[1])
        self.assertFalse(pb.is_self)
        self.assertEqual(pb.consecutive_failures, 0)
        self.assertIsNotNone(pb.last_ok_ms)
        self.assertGreaterEqual(sa.metrics.gossip_rounds, 1)

        data = sample_text(4000) + os.urandom(20_000)
        fid = hashlib.sha256(data).hexdigest()
        put = self.a.store_put(data)
        self.assertEqual(put.file_id, fid)
        try:
            g = self.b.store_get(fid)  # B does not hold it -> remote read from A
            self.assertEqual(g.data, data)
            self.assertEqual(g.headers.get("x-reactor-remote"), "1")
            self.assertEqual(self.b.store_get_bytes(fid, range=(100, 199)), data[100:200])
            st = self.b.store_stats()
            self.assertIsNotNone(st.cluster)
            self.assertGreaterEqual(st.cluster.remote_reads, 1)
            self.assertGreater(st.cluster.remote_read_bytes, 0)
            self.assertIsNotNone(st.group_commit)
            # A sees B advertise nothing and itself as holder
            sa = self.a.cluster_status()
            hs = [h for h in sa.holders_sample if h.file_id == fid]
            self.assertTrue(hs and hs[0].local and a_id in hs[0].holders)
        finally:
            # B does not hold the file: the unpin is forwarded to A (origin)
            d = self.b.store_delete(fid)
        self.assertEqual((d.file_id, d.pins, d.deleted, d.forwarded_to), (fid, 0, True, a_id))
        self.assertGreaterEqual(self.b.store_stats().cluster.unpins_forwarded, 1)
        with self.assertRaises(NotFoundError):
            self.a.store_get_bytes(fid)

    def test_cluster_admin_inventory_and_hold(self):
        adm = ClusterAdmin(self.cl.urls[0], self.cl.cluster_token, 10)
        data = sample_text(1500)
        put = self.a.store_put(data)
        try:
            inv = adm.inventory()
            self.assertTrue(inv.full)
            self.assertIn(put.file_id, inv.added)
            self.assertEqual(inv.node_id, self.a.cluster_status().node_id)
            delta = adm.inventory(since=inv.version, tsince=inv.now_ms)
            self.assertEqual(delta.version, inv.version)
            self.assertFalse(delta.full)
            self.assertEqual(delta.added, [])
            h = adm.hold(put.file_id, "sdktest")
            self.assertTrue(h.granted)
            self.assertGreater(h.expires_ms, 0)
            self.assertFalse(h.origin_accepted)
            refused = adm.hold("0" * 64, "sdktest")
            self.assertEqual((refused.granted, refused.reason), (False, "not held"))
            with self.assertRaises(AuthError):
                ClusterAdmin(self.cl.urls[0], "wrong", 10).inventory()
        finally:
            self.a.store_delete(put.file_id)


if __name__ == "__main__":
    unittest.main()
