"""Synchronous, dependency-free client for the Datran core reactor.

Implements the API described by ``core-reactor/openapi.yaml`` using :mod:`http.client` only.
"""

from __future__ import annotations

import http.client
import io
import json
import os
import random
import socket
import ssl
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import IO, Any, BinaryIO, Dict, Iterable, List, Optional, Tuple, Union

from .errors import DatranError, NotFoundError, TransportError, error_for_status

__all__ = [
    "Client",
    "CompressResult",
    "EntropyResult",
    "PutResult",
    "DeleteResult",
    "StoreStats",
    "StoreGcStats",
    "StoreFusionStats",
    "StoreScrubStats",
    "StoreGroupCommitStats",
    "ClusterMetrics",
    "ClusterStatus",
    "ClusterPeer",
    "FileHolders",
    "DemandEntry",
    "ClusterAdmin",
    "Inventory",
    "Tombstone",
    "HoldResult",
    "HeadResult",
    "GetResult",
    "RangeSpec",
    "format_range",
]

BytesLike = Union[bytes, bytearray, memoryview]
#: Request body: bytes, a binary file-like object (streamed), or an iterable of byte chunks (streamed, chunked).
Body = Union[BytesLike, BinaryIO, IO[bytes], Iterable[bytes]]
#: ``"bytes=0-99"``, ``(start, end_inclusive_or_None)`` or a negative int ``-n`` for the last ``n`` bytes.
RangeSpec = Union[str, Tuple[int, Optional[int]], int]

_CHUNK = 64 * 1024
_RETRY_STATUSES = frozenset({429, 502, 503, 504})


def format_range(r: RangeSpec) -> str:
    """Formats a :data:`RangeSpec` as an HTTP ``Range`` header value."""
    if isinstance(r, str):
        return r if r.startswith("bytes=") else "bytes=" + r
    if isinstance(r, bool):
        raise TypeError("invalid range")
    if isinstance(r, int):
        if r >= 0:
            raise ValueError("an int range must be negative (suffix length), e.g. -512")
        return f"bytes=-{-r}"
    start, end = r
    if start < 0 or (end is not None and end < start):
        raise ValueError(f"invalid range {r!r}")
    return f"bytes={start}-" + ("" if end is None else str(end))


@dataclass
class CompressResult:
    """Result of :meth:`Client.compress` (``data`` is ``None`` when written to a stream)."""

    data: Optional[bytes]
    content_class: str
    recipe: Optional[Dict[str, Any]]
    format: str
    original_size: int
    compressed_size: int
    algo: str = ""
    ratio: float = 0.0
    time_us: int = 0
    entropy: float = 0.0
    note: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict, repr=False)


@dataclass
class EntropyResult:
    size_bytes: int
    entropy_bits: float
    suggested_routing: str


def _req(j: Any, k: str, kind: Any) -> Any:
    """Required JSON field of an exact type (bool is not accepted as int; int is accepted as float)."""
    if not isinstance(j, dict) or k not in j:
        raise TransportError(f"invalid response: missing field {k!r}")
    v = j[k]
    if kind is float and isinstance(v, int) and not isinstance(v, bool):
        return float(v)
    if kind is int and isinstance(v, bool):
        raise TransportError(f"invalid response: field {k!r} is not an integer")
    if not isinstance(v, kind):
        raise TransportError(f"invalid response: field {k!r} has type {type(v).__name__}")
    return v


def _opt_int(j: Dict[str, Any], k: str) -> Optional[int]:
    return None if j.get(k) is None else _req(j, k, int)


@dataclass
class PutResult:
    """``PUT /store/files`` response."""

    file_id: str
    size: int
    #: Physical bytes of objects newly written by this upload.
    stored_bytes: int
    #: Plaintext bytes of the chunks newly stored by this upload (0 when ``duplicate``);
    #: compression of this upload = ``new_bytes / stored_bytes``.
    new_bytes: int
    #: Chunks not previously stored (0 when ``duplicate``).
    new_chunks: int
    #: Chunks already stored (all chunks when ``duplicate``).
    dedup_chunks: int
    #: Total chunks of the file.
    chunks: int
    #: Content class, e.g. ``text/json``, ``media/compressed``, ``empty``.
    content_class: str
    #: The file was already stored; only its pin count changed.
    duplicate: bool
    #: Pin count after this upload.
    pins: int
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "PutResult":
        return cls(
            file_id=_req(j, "file_id", str),
            size=_req(j, "size", int),
            stored_bytes=_req(j, "stored_bytes", int),
            new_bytes=_req(j, "new_bytes", int),
            new_chunks=_req(j, "new_chunks", int),
            dedup_chunks=_req(j, "dedup_chunks", int),
            chunks=_req(j, "chunks", int),
            content_class=_req(j, "class", str),
            duplicate=_req(j, "duplicate", bool),
            pins=_req(j, "pins", int),
            raw=j,
        )


@dataclass
class DeleteResult:
    """``DELETE /store/files/{id}`` response."""

    file_id: str
    #: Remaining pin count (0 when deleted).
    pins: int
    #: The manifest was removed and a tombstone written.
    deleted: bool
    #: Node id of the peer the unpin was forwarded to (the file's origin holder), when this node
    #: did not hold the file itself (data gravity, NETWORK_SPEC §4).
    forwarded_to: Optional[str] = None

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "DeleteResult":
        fwd = None if j.get("forwarded_to") is None else _req(j, "forwarded_to", str)
        return cls(_req(j, "file_id", str), _req(j, "pins", int), _req(j, "deleted", bool), fwd)


_KINDS = {"int": int, "float": float, "bool": bool, "str": str}


def _flat(model: Any, d: Any) -> Any:
    """Builds a dataclass whose fields are all int/float/bool/str from a JSON object (strict)."""
    if not isinstance(d, dict):
        raise TransportError(f"invalid response: expected an object for {model.__name__}")
    kw = {}
    for f in model.__dataclass_fields__.values():
        if f.name == "raw":
            continue
        kw[f.name] = _req(d, f.name, _KINDS[f.type if isinstance(f.type, str) else f.type.__name__])
    return model(**kw)


@dataclass
class StoreGcStats:
    queue_objects: int
    queue_bytes: int
    grace_ms: int
    collected_objects: int
    collected_bytes: int
    startup_orphans_removed: int
    startup_temp_files_removed: int


@dataclass
class StoreFusionStats:
    enabled: bool
    fusions: int
    unfusions: int
    bytes_saved: int
    reads_saved: int
    candidates_evaluated: int
    rejected: int
    last_run_ms: int
    access_rows: int
    coaccess_min: float


@dataclass
class StoreScrubStats:
    objects_checked: int
    bytes_checked: int
    corrupt_found: int
    passes_completed: int
    pass_progress_objects: int
    last_step_ms: int
    last_pass_ms: int
    quarantined: int


@dataclass
class StoreGroupCommitStats:
    """Group commit of concurrent uploads (one index transaction per batch)."""

    batches: int
    jobs: int
    max_batch: int
    window_ms: float


@dataclass
class ClusterMetrics:
    """Data-gravity counters (``/cluster/status`` ``metrics`` and ``/store/stats`` ``cluster``)."""

    gossip_rounds: int
    pulls: int
    pull_bytes: int
    pull_failures: int
    drops: int
    origin_transfers: int
    repairs: int
    remote_reads: int
    remote_read_bytes: int
    remote_objects_fetched: int
    remote_fetch_bytes: int
    remote_fetch_failures: int
    cache_hits: int
    cache_bytes: int
    cache_objects: int
    tombstones_applied: int
    quarantine_repairs: int
    quarantine_repair_failures: int
    leases_granted: int
    leases_refused: int
    leases_active: int
    evictions_confirmed: int
    unpins_forwarded: int


@dataclass
class StoreStats:
    """``GET /store/stats`` response (``raw`` keeps the full JSON, including fields added later)."""

    files: int
    logical_bytes: int
    unique_bytes: int
    physical_bytes: int
    live_physical_bytes: int
    #: ``REACTOR_STORE_MAX_BYTES``; ``None`` = unlimited.
    max_bytes: Optional[int]
    dedup_ratio: float
    compression_ratio: float
    total_ratio: float
    objects: int
    super_chunks: int
    chunks: int
    tombstones: int
    inventory_version: int
    inflight_bytes: int
    puts: int
    put_bytes: int
    reads: int
    read_bytes: int
    full_rejections: int
    evictions: int
    gc: StoreGcStats
    fusion: StoreFusionStats
    scrub: StoreScrubStats
    #: Group-commit counters (``None`` on reactors that predate them).
    group_commit: Optional[StoreGroupCommitStats] = None
    #: Data-gravity counters; present only when the cluster is enabled (``REACTOR_CLUSTER_TOKEN``).
    cluster: Optional[ClusterMetrics] = None
    #: Pack-file stats (loosely typed; shape not final yet). ``None`` when not reported.
    packs: Optional[Dict[str, Any]] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "StoreStats":
        def sub(name: str, model: Any) -> Any:
            return _flat(model, _req(j, name, dict))

        def opt(name: str, model: Any) -> Any:
            return None if j.get(name) is None else sub(name, model)

        ints = (
            "files logical_bytes unique_bytes physical_bytes live_physical_bytes objects super_chunks chunks "
            "tombstones inventory_version inflight_bytes puts put_bytes reads read_bytes full_rejections evictions"
        ).split()
        return cls(
            **{k: _req(j, k, int) for k in ints},
            max_bytes=_opt_int(j, "max_bytes"),
            dedup_ratio=_req(j, "dedup_ratio", float),
            compression_ratio=_req(j, "compression_ratio", float),
            total_ratio=_req(j, "total_ratio", float),
            gc=sub("gc", StoreGcStats),
            fusion=sub("fusion", StoreFusionStats),
            scrub=sub("scrub", StoreScrubStats),
            group_commit=opt("group_commit", StoreGroupCommitStats),
            cluster=opt("cluster", ClusterMetrics),
            packs=None if j.get("packs") is None else _req(j, "packs", dict),
            raw=j,
        )


def _opt_str(j: Dict[str, Any], k: str) -> Optional[str]:
    return None if j.get(k) is None else _req(j, k, str)


def _list(j: Dict[str, Any], k: str) -> List[Any]:
    return _req(j, k, list)


@dataclass
class DemandEntry:
    file_id: str
    #: Exponentially decayed request count.
    score: float

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "DemandEntry":
        return cls(_req(j, "file_id", str), _req(j, "score", float))


@dataclass
class ClusterPeer:
    """One configured peer as seen by this node (``/cluster/status`` ``peers``)."""

    url: str
    #: ``None`` until the first successful inventory fetch.
    node_id: Optional[str]
    region: Optional[str]
    #: Last inventory fetch succeeded and is younger than 3 x the gossip interval.
    healthy: bool
    #: The URL points back at this node.
    is_self: bool
    last_ok_ms: Optional[int]
    last_error: Optional[str]
    last_error_ms: Optional[int]
    consecutive_failures: int
    inventory_version: int
    #: Files the peer advertises.
    files: int
    capacity: Optional[int]
    used: int

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "ClusterPeer":
        return cls(
            url=_req(j, "url", str),
            node_id=_opt_str(j, "node_id"),
            region=_opt_str(j, "region"),
            healthy=_req(j, "healthy", bool),
            is_self=_req(j, "is_self", bool),
            last_ok_ms=_opt_int(j, "last_ok_ms"),
            last_error=_opt_str(j, "last_error"),
            last_error_ms=_opt_int(j, "last_error_ms"),
            consecutive_failures=_req(j, "consecutive_failures", int),
            inventory_version=_req(j, "inventory_version", int),
            files=_req(j, "files", int),
            capacity=_opt_int(j, "capacity"),
            used=_req(j, "used", int),
        )


@dataclass
class FileHolders:
    """Sampled replica placement (``/cluster/status`` ``holders_sample``)."""

    file_id: str
    #: Node ids holding a replica (sorted; includes this node when ``local``).
    holders: List[str]
    local: bool
    #: Local demand score.
    demand: float

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "FileHolders":
        holders = _list(j, "holders")
        if not all(isinstance(h, str) for h in holders):
            raise TransportError("invalid response: holders must be strings")
        return cls(_req(j, "file_id", str), holders, _req(j, "local", bool), _req(j, "demand", float))


@dataclass
class ClusterStatus:
    """``GET /cluster/status`` response (``raw`` keeps the full JSON)."""

    node_id: str
    region: Optional[str]
    #: This node serves HTTPS.
    tls: bool
    #: This node plus its non-self peers.
    cluster_size: int
    #: ``REACTOR_MIN_REPLICAS``.
    min_replicas: int
    #: ``min(min_replicas, cluster_size)``.
    min_replicas_effective: int
    #: ``REACTOR_GRAVITY_PULL``.
    gravity_pull: float
    demand_half_life_ms: int
    gossip_interval_ms: int
    #: ``REACTOR_STORE_MAX_BYTES`` (``None`` = unlimited).
    capacity: Optional[int]
    #: Live physical + in-flight bytes (``None`` if unavailable).
    used: Optional[int]
    peers: List[ClusterPeer]
    holders_sample: List[FileHolders]
    demand_top: List[DemandEntry]
    metrics: ClusterMetrics
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "ClusterStatus":
        return cls(
            node_id=_req(j, "node_id", str),
            region=_opt_str(j, "region"),
            tls=_req(j, "tls", bool),
            cluster_size=_req(j, "cluster_size", int),
            min_replicas=_req(j, "min_replicas", int),
            min_replicas_effective=_req(j, "min_replicas_effective", int),
            gravity_pull=_req(j, "gravity_pull", float),
            demand_half_life_ms=_req(j, "demand_half_life_ms", int),
            gossip_interval_ms=_req(j, "gossip_interval_ms", int),
            capacity=_opt_int(j, "capacity"),
            used=_opt_int(j, "used"),
            peers=[ClusterPeer.from_json(p) for p in _list(j, "peers")],
            holders_sample=[FileHolders.from_json(h) for h in _list(j, "holders_sample")],
            demand_top=[DemandEntry.from_json(d) for d in _list(j, "demand_top")],
            metrics=_flat(ClusterMetrics, _req(j, "metrics", dict)),
            raw=j,
        )

    def peer(self, node_id: str) -> Optional[ClusterPeer]:
        """The peer with this node id, if known."""
        return next((p for p in self.peers if p.node_id == node_id), None)


@dataclass
class Tombstone:
    file_id: str
    deleted_ms: int


@dataclass
class Inventory:
    """``GET /cluster/inventory`` response (internal, see :class:`ClusterAdmin`)."""

    node_id: str
    region: Optional[str]
    #: Version covered by this response (resume with ``since=version``).
    version: int
    #: ``added`` is the complete file list.
    full: bool
    #: More delta events are available beyond ``version``.
    more: bool
    capacity: Optional[int]
    used: int
    added: List[str]
    removed: List[str]
    tombstones: List[Tombstone]
    demand: List[DemandEntry]
    #: Server clock (use as the next ``tsince``).
    now_ms: int

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "Inventory":
        return cls(
            node_id=_req(j, "node_id", str),
            region=_opt_str(j, "region"),
            version=_req(j, "version", int),
            full=_req(j, "full", bool),
            more=_req(j, "more", bool),
            capacity=_opt_int(j, "capacity"),
            used=_req(j, "used", int),
            added=list(_list(j, "added")),
            removed=list(_list(j, "removed")),
            tombstones=[Tombstone(_req(t, "file_id", str), _req(t, "deleted_ms", int)) for t in _list(j, "tombstones")],
            demand=[DemandEntry.from_json(d) for d in _list(j, "demand")],
            now_ms=_req(j, "now_ms", int),
        )


@dataclass
class HoldResult:
    """``POST /cluster/hold/{id}`` response (internal, see :class:`ClusterAdmin`)."""

    file_id: str
    #: The holder's node id.
    node_id: str
    granted: bool
    #: Lease expiry (holder clock, unix ms); 0 when not granted.
    expires_ms: int
    lease_ms: int
    #: The holder took over origin (and the pins) as requested.
    origin_accepted: bool
    #: Why the lease was refused (``"not held"``, ``"dropping"``).
    reason: Optional[str]

    @classmethod
    def from_json(cls, j: Dict[str, Any]) -> "HoldResult":
        return cls(
            _req(j, "file_id", str),
            _req(j, "node_id", str),
            _req(j, "granted", bool),
            _req(j, "expires_ms", int),
            _req(j, "lease_ms", int),
            _req(j, "origin_accepted", bool),
            _opt_str(j, "reason"),
        )


@dataclass
class HeadResult:
    size: int
    accept_ranges: Optional[str]
    #: Strong ETag (the quoted lowercase file id).
    etag: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict, repr=False)


@dataclass
class GetResult:
    """Metadata of a (possibly partial) download.

    ``start``/``end`` are the inclusive byte offsets served; ``total`` the full file size when known.
    ``data`` is ``None`` when the body was written to a stream.
    """

    status: int
    data: Optional[bytes]
    length: int
    start: int
    end: int
    total: Optional[int]
    headers: Dict[str, str] = field(default_factory=dict, repr=False)

    @property
    def partial(self) -> bool:
        return self.status == 206

    @property
    def etag(self) -> Optional[str]:
        """Strong ETag (the quoted lowercase file id)."""
        return self.headers.get("etag")


class _Response:
    """An open HTTP response; must be closed (use as a context manager)."""

    def __init__(self, conn: http.client.HTTPConnection, resp: http.client.HTTPResponse):
        self.conn = conn
        self.resp = resp
        self.status = resp.status
        self.headers = {k.lower(): v for k, v in resp.getheaders()}

    def read_all(self) -> bytes:
        try:
            return self.resp.read()
        except (OSError, http.client.HTTPException) as e:
            raise TransportError(f"error reading response: {e}") from e

    def iter_chunks(self, size: int = _CHUNK) -> Iterable[bytes]:
        while True:
            try:
                b = self.resp.read(size)
            except (OSError, http.client.HTTPException) as e:
                raise TransportError(f"error reading response: {e}") from e
            if not b:
                return
            yield b

    def close(self) -> None:
        try:
            self.resp.close()
        finally:
            self.conn.close()

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class Client:
    """Client for one reactor.

    :param base_url: e.g. ``"http://127.0.0.1:3005"`` (``https://`` supported).
    :param token: value for ``x-reactor-token`` (``None`` when the reactor runs without a token).
    :param timeout: socket timeout in seconds for connect and each read/write.
    :param max_retries: retries for idempotent requests (GET/HEAD) on transport errors and 429/502/503/504.
    :param backoff: base delay in seconds; attempt ``n`` waits ``backoff * 2**n`` (+ jitter, capped at 10 s).
    :param ssl_context: custom TLS context for ``https`` URLs.
    """

    def __init__(
        self,
        base_url: str,
        token: Optional[str] = None,
        timeout: float = 60.0,
        *,
        max_retries: int = 3,
        backoff: float = 0.2,
        ssl_context: Optional[ssl.SSLContext] = None,
        user_agent: str = "datran-client-python/0.1.0",
    ):
        u = urllib.parse.urlsplit(base_url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ValueError(f"invalid base_url {base_url!r}")
        self.base_url = base_url.rstrip("/")
        self._https = u.scheme == "https"
        self._host = u.hostname
        self._port = u.port or (443 if self._https else 80)
        self._prefix = u.path.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_retries = max(0, max_retries)
        self.backoff = backoff
        self._ssl = ssl_context
        self._ua = user_agent

    # ------------------------------------------------------------------ transport

    def _connect(self) -> http.client.HTTPConnection:
        if self._https:
            ctx = self._ssl or ssl.create_default_context()
            return http.client.HTTPSConnection(self._host, self._port, timeout=self.timeout, context=ctx)
        return http.client.HTTPConnection(self._host, self._port, timeout=self.timeout)

    def _headers(self, extra: Optional[Dict[str, str]]) -> Dict[str, str]:
        h = {"User-Agent": self._ua, "Accept-Encoding": "identity"}
        if self.token:
            h["x-reactor-token"] = self.token
        if extra:
            h.update(extra)
        return h

    def _open(
        self,
        method: str,
        path: str,
        body: Optional[Body] = None,
        headers: Optional[Dict[str, str]] = None,
        length: Optional[int] = None,
    ) -> _Response:
        """Sends one request and returns the open response (any status). Raises TransportError."""
        h = self._headers(headers)
        send: Any = body
        if body is None:
            if method in ("POST", "PUT"):
                h["Content-Length"] = "0"
        elif isinstance(body, (bytes, bytearray, memoryview)):
            h["Content-Length"] = str(len(body))
            send = bytes(body) if isinstance(body, memoryview) else body
        elif length is not None:
            h["Content-Length"] = str(length)
        elif hasattr(body, "read"):
            n = _remaining_length(body)  # type: ignore[arg-type]
            if n is not None:
                h["Content-Length"] = str(n)
            else:
                send = _iter_file(body)  # type: ignore[arg-type]
                h["Transfer-Encoding"] = "chunked"
        else:
            send = iter(body)  # type: ignore[arg-type]
            h["Transfer-Encoding"] = "chunked"
        conn = self._connect()
        try:
            conn.putrequest(method, self._prefix + path, skip_accept_encoding=True)
            for k, v in h.items():
                conn.putheader(k, v)
            conn.endheaders()
            chunked = h.get("Transfer-Encoding") == "chunked"
            if send is not None:
                if isinstance(send, (bytes, bytearray)):
                    conn.send(send)
                elif hasattr(send, "read"):
                    _send_file(conn, send, length if length is not None else int(h["Content-Length"]))
                else:
                    for chunk in send:
                        if not chunk:
                            continue
                        if chunked:
                            conn.send(b"%X\r\n" % len(chunk) + bytes(chunk) + b"\r\n")
                        else:
                            conn.send(chunk)
                    if chunked:
                        conn.send(b"0\r\n\r\n")
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            conn.close()
            if isinstance(e, socket.timeout) or "timed out" in str(e):
                raise TransportError(f"{method} {path}: timed out after {self.timeout}s") from e
            raise TransportError(f"{method} {path}: {e}") from e
        except BaseException:
            conn.close()
            raise
        return _Response(conn, resp)

    def _call(
        self,
        method: str,
        path: str,
        body: Optional[Body] = None,
        headers: Optional[Dict[str, str]] = None,
        *,
        length: Optional[int] = None,
        ok: Tuple[int, ...] = (),
    ) -> _Response:
        """Like :meth:`_open` but raises ApiError on non-2xx and retries idempotent requests."""
        idempotent = method in ("GET", "HEAD") and (body is None)
        attempts = self.max_retries + 1 if idempotent else 1
        last: Optional[DatranError] = None
        for attempt in range(attempts):
            if attempt:
                delay = min(10.0, self.backoff * (2 ** (attempt - 1)))
                time.sleep(delay + random.uniform(0, delay / 2))
            try:
                r = self._open(method, path, body, headers, length)
            except TransportError as e:
                last = e
                continue
            if 200 <= r.status < 300 or r.status in ok:
                return r
            try:
                data = b"" if method == "HEAD" else r.read_all()
            finally:
                r.close()
            err = error_for_status(r.status, data, r.headers)
            if idempotent and r.status in _RETRY_STATUSES and attempt + 1 < attempts:
                last = err
                continue
            raise err
        assert last is not None
        raise last

    def _json(self, method: str, path: str, body: Optional[Body] = None, headers: Optional[Dict[str, str]] = None) -> Any:
        with self._call(method, path, body, headers) as r:
            data = r.read_all()
        if not data:
            return None
        try:
            return json.loads(data.decode("utf-8"))
        except ValueError as e:
            raise TransportError(f"{method} {path}: invalid JSON response: {e}") from e

    # ------------------------------------------------------------------ system / data plane

    def health(self) -> Dict[str, Any]:
        """``GET /health`` (no auth)."""
        return self._json("GET", "/health")

    def compress(self, data: Body, *, content_type: Optional[str] = None, no_sample: bool = False) -> CompressResult:
        """``POST /compress``. ``data`` may be bytes, a binary file-like object or an iterable of chunks."""
        with self._call("POST", "/compress", data, _hints(content_type, no_sample)) as r:
            blob = r.read_all()
            return _compress_result(blob, r.headers)

    def compress_to(
        self, data: Body, out: IO[bytes], *, content_type: Optional[str] = None, no_sample: bool = False
    ) -> CompressResult:
        """Streams the compressed blob into ``out``; the result's ``data`` is ``None``."""
        with self._call("POST", "/compress", data, _hints(content_type, no_sample)) as r:
            for chunk in r.iter_chunks():
                out.write(chunk)
            return _compress_result(None, r.headers)

    def decompress(self, blob: Body) -> bytes:
        """``POST /decompress``. Raises :class:`BadRequestError` for corrupt blobs or unknown dictionaries."""
        with self._call("POST", "/decompress", blob) as r:
            return r.read_all()

    def decompress_to(self, blob: Body, out: IO[bytes]) -> int:
        """Streams the decoded bytes into ``out`` and returns the number of bytes written."""
        n = 0
        with self._call("POST", "/decompress", blob) as r:
            for chunk in r.iter_chunks():
                out.write(chunk)
                n += len(chunk)
        return n

    def entropy(self, data: Body) -> EntropyResult:
        """``POST /entropy``."""
        j = self._json("POST", "/entropy", data)
        return EntropyResult(int(j["size_bytes"]), float(j["entropy_bits"]), str(j["suggested_routing"]))

    def evolution_status(self) -> Dict[str, Any]:
        """``GET /evolution/status`` (see ``EvolutionStatus`` in openapi.yaml)."""
        return self._json("GET", "/evolution/status")

    # ------------------------------------------------------------------ store

    def store_put(
        self,
        source: Union[Body, str, "os.PathLike[str]"],
        *,
        content_type: Optional[str] = None,
        no_sample: bool = False,
        length: Optional[int] = None,
    ) -> PutResult:
        """``PUT /store/files``: streams ``source`` (bytes, path, file-like or iterable of chunks).

        Known lengths are sent with ``Content-Length``; unknown ones with chunked transfer encoding.
        Never retried (each successful PUT adds a pin). Raises :class:`InsufficientStorageError` (507,
        with ``needed``/``used``/``max``) when the store is full.
        """
        if isinstance(source, (str, os.PathLike)):
            size = os.path.getsize(source)
            with open(source, "rb") as f:
                return self.store_put(f, content_type=content_type, no_sample=no_sample, length=size)
        j = self._json_call("PUT", "/store/files", source, _hints(content_type, no_sample), length)
        return PutResult.from_json(j)

    def _json_call(self, method: str, path: str, body: Optional[Body], headers: Dict[str, str], length: Optional[int]) -> Any:
        with self._call(method, path, body, headers, length=length) as r:
            data = r.read_all()
        try:
            return json.loads(data.decode("utf-8")) if data else {}
        except ValueError as e:
            raise TransportError(f"{method} {path}: invalid JSON response: {e}") from e

    def store_get(self, file_id: str, *, range: Optional[RangeSpec] = None) -> GetResult:
        """``GET /store/files/{id}`` into memory. With ``range`` the server answers 206 (or 416)."""
        buf = io.BytesIO()
        res = self.store_get_to(file_id, buf, range=range)
        res.data = buf.getvalue()
        return res

    def store_get_bytes(self, file_id: str, *, range: Optional[RangeSpec] = None) -> bytes:
        """Convenience: the body of :meth:`store_get`."""
        data = self.store_get(file_id, range=range).data
        assert data is not None
        return data

    def store_get_to(self, file_id: str, out: IO[bytes], *, range: Optional[RangeSpec] = None) -> GetResult:
        """Streams a file (or range) into ``out``.

        Transport failures before the first byte is written are retried; a failure mid-body raises
        :class:`TransportError` (resume with ``range=(bytes_written + start, end)``).
        """
        headers = {"Range": format_range(range)} if range is not None else None
        path = "/store/files/" + _id(file_id)
        with self._call("GET", path, None, headers) as r:
            n = 0
            for chunk in r.iter_chunks():
                out.write(chunk)
                n += len(chunk)
            expected = r.headers.get("content-length")
            if expected is not None and int(expected) != n:
                raise TransportError(f"GET {path}: truncated body ({n} of {expected} bytes)")
            start, end, total = 0, n - 1, n
            cr = r.headers.get("content-range")
            if r.status == 206 and cr:
                start, end, total_opt = _parse_content_range(cr)
                total = total_opt if total_opt is not None else -1
            return GetResult(r.status, None, n, start, end, None if total < 0 else total, r.headers)

    def store_head(self, file_id: str) -> HeadResult:
        """``HEAD /store/files/{id}``: size, ``Accept-Ranges`` and ``ETag``. Raises :class:`NotFoundError`."""
        with self._call("HEAD", "/store/files/" + _id(file_id)) as r:
            size = int(r.headers.get("content-length", "0"))
            return HeadResult(size, r.headers.get("accept-ranges"), r.headers.get("etag"), r.headers)

    def store_exists(self, file_id: str) -> bool:
        try:
            self.store_head(file_id)
            return True
        except NotFoundError:
            return False

    def store_delete(self, file_id: str) -> DeleteResult:
        """``DELETE /store/files/{id}`` (unpin once; never retried). :class:`NotFoundError` once no longer stored."""
        return DeleteResult.from_json(self._json("DELETE", "/store/files/" + _id(file_id)))

    def store_stats(self) -> StoreStats:
        """``GET /store/stats``. Raises :class:`ServerError` (503) when the store is disabled."""
        return StoreStats.from_json(self._json("GET", "/store/stats"))

    def cluster_status(self) -> ClusterStatus:
        """``GET /cluster/status`` (``x-reactor-token``): node config, per-peer health, sampled holders,
        top demand and data-gravity metrics. Raises :class:`ServerError` (503) when data gravity is
        disabled (no store or no ``REACTOR_CLUSTER_TOKEN``)."""
        return ClusterStatus.from_json(self._json("GET", "/cluster/status"))


class ClusterAdmin:
    """Low-level access to the internal peer endpoints (``x-cluster-token``).

    Intended for operators and debugging tools, not applications: only ``/cluster/inventory`` and
    ``/cluster/hold/{id}`` are wrapped (manifests, objects, chunks and unpin are peer-to-peer
    transfer endpoints, see ``openapi.yaml``). Note that a granted hold is a real lease: the holder
    will not drop the replica for ``lease_ms``.
    """

    def __init__(self, base_url: str, cluster_token: str, timeout: float = 30.0, **kwargs: Any):
        self._c = Client(base_url, None, timeout, **kwargs)
        self._h = {"x-cluster-token": cluster_token}

    def inventory(self, since: Optional[int] = None, tsince: Optional[int] = None) -> Inventory:
        """``GET /cluster/inventory``: full listing without ``since``, else the delta after ``since``."""
        q = {k: str(v) for k, v in (("since", since), ("tsince", tsince)) if v is not None}
        path = "/cluster/inventory" + ("?" + urllib.parse.urlencode(q) if q else "")
        return Inventory.from_json(self._c._json("GET", path, None, self._h))

    def hold(self, file_id: str, node: str, *, origin: bool = False, pins: int = 0) -> HoldResult:
        """``POST /cluster/hold/{id}?node=..``: asks the node to lease (not drop) its replica.

        ``origin=True`` additionally asks it to take over origin and ``pins`` pins. Never retried.
        """
        q = {"node": node}
        if origin:
            q["origin"] = "1"
            q["pins"] = str(pins)
        path = "/cluster/hold/" + _id(file_id) + "?" + urllib.parse.urlencode(q)
        return HoldResult.from_json(self._c._json("POST", path, None, self._h))


# ---------------------------------------------------------------------- helpers


def _hints(content_type: Optional[str], no_sample: bool) -> Dict[str, str]:
    h: Dict[str, str] = {"Content-Type": "application/octet-stream"}
    if content_type:
        h["x-content-type"] = content_type
    if no_sample:
        h["x-reactor-no-sample"] = "1"
    return h


def _id(file_id: str) -> str:
    return urllib.parse.quote(file_id, safe="")


def _remaining_length(f: IO[bytes]) -> Optional[int]:
    try:
        if isinstance(f, io.BytesIO):
            return len(f.getbuffer()) - f.tell()
        fd = f.fileno()
        st = os.fstat(fd)
        import stat as _stat

        if not _stat.S_ISREG(st.st_mode):
            return None
        return st.st_size - f.tell()
    except (AttributeError, OSError, ValueError, io.UnsupportedOperation):
        return None


def _iter_file(f: IO[bytes]) -> Iterable[bytes]:
    while True:
        b = f.read(_CHUNK)
        if not b:
            return
        yield b


def _send_file(conn: http.client.HTTPConnection, f: IO[bytes], length: int) -> None:
    left = length
    while left > 0:
        b = f.read(min(_CHUNK, left))
        if not b:
            raise TransportError(f"request body ended {left} bytes before the declared length {length}")
        conn.send(b)
        left -= len(b)


def _parse_content_range(v: str) -> Tuple[int, int, Optional[int]]:
    # "bytes 0-99/1000" or "bytes 0-99/*"
    try:
        unit, rest = v.strip().split(" ", 1)
        span, total = rest.split("/", 1)
        a, b = span.split("-", 1)
        return int(a), int(b), (None if total.strip() == "*" else int(total))
    except ValueError as e:
        raise TransportError(f"invalid Content-Range {v!r}") from e


def _compress_result(blob: Optional[bytes], h: Dict[str, str]) -> CompressResult:
    recipe_raw = h.get("x-reactor-recipe", "null")
    try:
        recipe = json.loads(recipe_raw)
    except ValueError:
        recipe = None
    ratio = h.get("x-datran-ratio", "0").rstrip("x")

    def num(k: str, f: Any = int, d: Any = 0) -> Any:
        try:
            return f(h[k])
        except (KeyError, ValueError):
            return d

    return CompressResult(
        data=blob,
        content_class=h.get("x-reactor-class", ""),
        recipe=recipe if isinstance(recipe, dict) else None,
        format=h.get("x-reactor-format", ""),
        original_size=num("x-original-size"),
        compressed_size=num("x-compressed-size", int, len(blob) if blob is not None else 0),
        algo=h.get("x-datran-algo", ""),
        ratio=float(ratio) if ratio.replace(".", "", 1).isdigit() else 0.0,
        time_us=num("x-datran-time-us"),
        entropy=num("x-datran-entropy", float, 0.0),
        note=h.get("x-reactor-note"),
        headers=h,
    )

