"""Offline tests: helpers, error mapping, retry policy and chunked uploads against a stub server."""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from datran_client import (  # noqa: E402
    AuthError,
    BadRequestError,
    Client,
    ClusterAdmin,
    ClusterStatus,
    DeleteResult,
    HoldResult,
    InsufficientStorageError,
    Inventory,
    RangeNotSatisfiableError,
    ServerError,
    StoreStats,
    TransportError,
    format_range,
)
from datran_client.errors import error_for_status  # noqa: E402

_MKEYS = (
    "gossip_rounds pulls pull_bytes pull_failures drops origin_transfers repairs remote_reads remote_read_bytes "
    "remote_objects_fetched remote_fetch_bytes remote_fetch_failures cache_hits cache_bytes cache_objects "
    "tombstones_applied quarantine_repairs quarantine_repair_failures leases_granted leases_refused leases_active "
    "evictions_confirmed unpins_forwarded"
).split()
METRICS = {k: i + 1 for i, k in enumerate(_MKEYS)}
CLUSTER_STATUS = json.dumps({
    "node_id": "a" * 32, "region": None, "tls": False, "cluster_size": 2, "min_replicas": 2,
    "min_replicas_effective": 2, "gravity_pull": 3.0, "demand_half_life_ms": 3600000, "gossip_interval_ms": 200,
    "capacity": None, "used": 123,
    "peers": [
        {"url": "http://127.0.0.1:1", "node_id": "b" * 32, "region": "eu", "healthy": True, "is_self": False,
         "last_ok_ms": 1700000000000, "last_error": None, "last_error_ms": None, "consecutive_failures": 0,
         "inventory_version": 4, "files": 1, "capacity": None, "used": 99},
        {"url": "http://127.0.0.1:2", "node_id": None, "region": None, "healthy": False, "is_self": False,
         "last_ok_ms": None, "last_error": "connection refused", "last_error_ms": 1700000000001,
         "consecutive_failures": 3, "inventory_version": 0, "files": 0, "capacity": None, "used": 0},
    ],
    "holders_sample": [{"file_id": "ab" * 32, "holders": ["a" * 32, "b" * 32], "local": True, "demand": 0.0}],
    "demand_top": [{"file_id": "ab" * 32, "score": 1.5}],
    "metrics": METRICS,
})
INVENTORY = json.dumps({
    "node_id": "a" * 32, "region": None, "version": 7, "full": True, "more": False, "capacity": None, "used": 1,
    "added": ["ab" * 32], "removed": [], "tombstones": [{"file_id": "cd" * 32, "deleted_ms": 5}],
    "demand": [{"file_id": "ab" * 32, "score": 2}], "now_ms": 1700000000000,
})


class Stub(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    hits: List[str] = []
    fail_first = 0
    received: List[bytes] = []
    received_headers: List[dict] = []

    def log_message(self, *a):  # silence
        pass

    def _body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                n = int(self.rfile.readline().strip(), 16)
                if n == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(n)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("Content-Length", "0")))

    def _reply(self, status: int, body: bytes, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        Stub.hits.append("GET " + self.path)
        if Stub.fail_first > 0:
            Stub.fail_first -= 1
            return self._reply(503, b'{"error":"busy"}')
        self._reply(200, b'{"status":"online"}')

    def do_POST(self):
        Stub.hits.append("POST " + self.path)
        self._body()
        self._reply(503, b'{"error":"busy"}')

    def do_PUT(self):
        Stub.hits.append("PUT " + self.path)
        Stub.received_headers.append(dict(self.headers))
        body = self._body()
        Stub.received.append(body)
        self._reply(200, json.dumps({"file_id": "ab" * 32, "size": len(body), "stored_bytes": 1,
                                     "new_bytes": len(body), "new_chunks": 1, "dedup_chunks": 0, "chunks": 1, "class": "binary/structured",
                                     "duplicate": False, "pins": 1}).encode())


class UnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        Stub.hits = []
        Stub.received = []
        Stub.received_headers = []
        Stub.fail_first = 0

    def test_format_range(self):
        self.assertEqual(format_range((0, 99)), "bytes=0-99")
        self.assertEqual(format_range((10, None)), "bytes=10-")
        self.assertEqual(format_range(-5), "bytes=-5")
        self.assertEqual(format_range("bytes=1-2"), "bytes=1-2")
        self.assertEqual(format_range("3-4"), "bytes=3-4")
        with self.assertRaises(ValueError):
            format_range((5, 1))
        with self.assertRaises(ValueError):
            format_range(5)

    def test_error_mapping(self):
        e = error_for_status(401, b'{"error":"missing or invalid x-reactor-token"}', {})
        self.assertIsInstance(e, AuthError)
        self.assertEqual(e.status, 401)
        self.assertEqual(e.message, "missing or invalid x-reactor-token")
        e = error_for_status(400, b'{"error":"x","unknown_dict":"' + b"0" * 64 + b'"}', {})
        self.assertIsInstance(e, BadRequestError)
        self.assertEqual(e.unknown_dict, "0" * 64)
        e = error_for_status(416, b"", {"content-range": "bytes */1234"})
        self.assertIsInstance(e, RangeNotSatisfiableError)
        self.assertEqual(e.size, 1234)
        self.assertIsInstance(error_for_status(507, b"", {}), InsufficientStorageError)
        full = error_for_status(507, b'{"error":"store full","needed":10,"used":90,"max":95}', {})
        self.assertEqual((full.message, full.needed, full.used, full.max), ("store full", 10, 90, 95))
        self.assertIsInstance(error_for_status(502, b"", {}), ServerError)

    def test_models(self):
        stats = json.loads(
            '{"chunks":0,"compression_ratio":1.0,"dedup_ratio":1,"evictions":0,"files":0,"full_rejections":0,'
            '"fusion":{"access_rows":0,"bytes_saved":0,"candidates_evaluated":0,"coaccess_min":8.0,"enabled":true,'
            '"fusions":0,"last_run_ms":0,"reads_saved":0,"rejected":0,"unfusions":0},"gc":{"collected_bytes":0,'
            '"collected_objects":0,"grace_ms":600000,"queue_bytes":0,"queue_objects":0,"startup_orphans_removed":0,'
            '"startup_temp_files_removed":0},"inflight_bytes":0,"inventory_version":0,"live_physical_bytes":0,'
            '"logical_bytes":0,"max_bytes":null,"objects":0,"physical_bytes":0,"put_bytes":0,"puts":0,"read_bytes":0,'
            '"reads":0,"scrub":{"bytes_checked":0,"corrupt_found":0,"last_pass_ms":0,"last_step_ms":0,'
            '"objects_checked":0,"pass_progress_objects":0,"passes_completed":0,"quarantined":0},"super_chunks":0,'
            '"tombstones":0,"total_ratio":1.0,"unique_bytes":0}'
        )
        s = StoreStats.from_json(stats)
        self.assertIsNone(s.max_bytes)
        self.assertEqual(s.gc.grace_ms, 600000)
        self.assertEqual(s.fusion.coaccess_min, 8.0)
        self.assertIsInstance(s.dedup_ratio, float)
        self.assertTrue(s.fusion.enabled)
        del stats["scrub"]["quarantined"]
        with self.assertRaises(TransportError):
            StoreStats.from_json(stats)
        stats["scrub"]["quarantined"] = 0
        self.assertIsNone(StoreStats.from_json(stats).group_commit)
        stats["group_commit"] = {"batches": 3, "jobs": 5, "max_batch": 2, "window_ms": 2.0}
        stats["cluster"] = METRICS
        stats["packs"] = {"files": 1, "future_field": [1, 2]}
        s = StoreStats.from_json(stats)
        self.assertEqual((s.group_commit.jobs, s.group_commit.window_ms), (5, 2.0))
        self.assertEqual(s.cluster.unpins_forwarded, 23)
        self.assertEqual(s.packs["files"], 1)
        d = DeleteResult.from_json({"file_id": "ab" * 32, "pins": 0, "deleted": True})
        self.assertTrue(d.deleted)
        self.assertIsNone(d.forwarded_to)
        d = DeleteResult.from_json({"file_id": "ab" * 32, "pins": 0, "deleted": True, "forwarded_to": "n1"})
        self.assertEqual(d.forwarded_to, "n1")
        with self.assertRaises(TransportError):
            DeleteResult.from_json({"file_id": "ab" * 32, "pins": True, "deleted": True})

    def test_cluster_models(self):
        cs = ClusterStatus.from_json(json.loads(CLUSTER_STATUS))
        self.assertEqual((cs.node_id, cs.region, cs.tls, cs.cluster_size), ("a" * 32, None, False, 2))
        self.assertEqual((cs.capacity, cs.used, cs.gravity_pull), (None, 123, 3.0))
        self.assertEqual(len(cs.peers), 2)
        b = cs.peer("b" * 32)
        self.assertTrue(b.healthy and not b.is_self and b.files == 1 and b.capacity is None)
        self.assertIsNone(cs.peers[1].node_id)
        self.assertEqual(cs.peers[1].last_error, "connection refused")
        self.assertEqual(cs.holders_sample[0].holders, ["a" * 32, "b" * 32])
        self.assertEqual(cs.demand_top[0].score, 1.5)
        self.assertEqual(cs.metrics.gossip_rounds, 1)
        inv = Inventory.from_json(json.loads(INVENTORY))
        self.assertEqual((inv.version, inv.full, inv.more, inv.now_ms), (7, True, False, 1700000000000))
        self.assertEqual(inv.tombstones[0].deleted_ms, 5)
        h = HoldResult.from_json({"file_id": "ab" * 32, "node_id": "n", "granted": False, "expires_ms": 0,
                                  "lease_ms": 600000, "origin_accepted": False, "reason": "not held"})
        self.assertEqual((h.granted, h.reason), (False, "not held"))
        bad = json.loads(CLUSTER_STATUS)
        del bad["metrics"]["pulls"]
        with self.assertRaises(TransportError):
            ClusterStatus.from_json(bad)

    def test_cluster_admin_headers(self):
        a = ClusterAdmin(self.url, "ctok", 5)
        with self.assertRaises(ServerError):  # stub answers POST with 503; never retried
            a.hold("ab" * 32, "node1", origin=True, pins=2)
        self.assertEqual(Stub.hits, [f"POST /cluster/hold/{'ab' * 32}?node=node1&origin=1&pins=2"])

    def test_get_retried_on_503(self):
        Stub.fail_first = 2
        c = Client(self.url, "t", 5, backoff=0.01)
        self.assertEqual(c.health()["status"], "online")
        self.assertEqual(len(Stub.hits), 3)

    def test_get_gives_up_after_max_retries(self):
        Stub.fail_first = 10
        c = Client(self.url, "t", 5, max_retries=2, backoff=0.01)
        with self.assertRaises(ServerError) as cm:
            c.health()
        self.assertEqual(cm.exception.status, 503)
        self.assertEqual(len(Stub.hits), 3)

    def test_post_not_retried(self):
        c = Client(self.url, "t", 5, backoff=0.01)
        with self.assertRaises(ServerError):
            c.decompress(b"abc")
        self.assertEqual(Stub.hits, ["POST /decompress"])

    def test_put_chunked_and_known_length(self):
        c = Client(self.url, "t", 5)
        data = os.urandom(200_000)
        # iterable -> chunked
        r = c.store_put(iter([data[:70_000], data[70_000:]]))
        self.assertEqual(r.size, len(data))
        self.assertEqual((r.content_class, r.duplicate, r.pins, r.chunks), ("binary/structured", False, 1, 1))
        self.assertEqual(Stub.received[-1], data)
        self.assertEqual(Stub.received_headers[-1].get("Transfer-Encoding"), "chunked")

        # non-seekable stream -> chunked
        class Pipe(io.RawIOBase):
            def __init__(self, b):
                self.b = io.BytesIO(b)

            def readable(self):
                return True

            def read(self, n=-1):
                return self.b.read(n)

        c.store_put(Pipe(data), content_type="application/x-test", no_sample=True)
        self.assertEqual(Stub.received[-1], data)
        self.assertEqual(Stub.received_headers[-1].get("x-content-type"), "application/x-test")
        self.assertEqual(Stub.received_headers[-1].get("x-reactor-no-sample"), "1")
        # BytesIO -> Content-Length
        c.store_put(io.BytesIO(data))
        self.assertEqual(Stub.received_headers[-1].get("Content-Length"), str(len(data)))
        self.assertEqual(Stub.received[-1], data)
        self.assertEqual(Stub.hits.count("PUT /store/files"), 3)

    def test_connection_refused_is_transport_error(self):
        c = Client("http://127.0.0.1:9", None, 2, max_retries=1, backoff=0.01)
        t = time.time()
        with self.assertRaises(TransportError):
            c.health()
        self.assertLess(time.time() - t, 10)


if __name__ == "__main__":
    unittest.main()
