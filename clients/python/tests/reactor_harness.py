"""Starts a live reactor for the test suite (or uses REACTOR_URL).

Environment:
  REACTOR_URL    use an already running reactor (with REACTOR_TOKEN if it requires one)
  REACTOR_BIN    path to the core-reactor binary to start on an ephemeral port
  REACTOR_TOKEN  token (default: a random test token when starting the binary)
If neither is set, ../../core-reactor/target/release/core-reactor[.exe] is used when present,
otherwise live tests are skipped.
"""

from __future__ import annotations

import atexit
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from typing import Optional, Tuple

_state: Optional[Tuple[str, Optional[str]]] = None
_proc: Optional[subprocess.Popen] = None
_tmp: Optional[str] = None
_skip_reason: Optional[str] = None
_log = None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _default_bin() -> Optional[str]:
    root = Path(__file__).resolve().parents[3]
    for name in ("core-reactor.exe", "core-reactor"):
        p = root / "core-reactor" / "target" / "release" / name
        if p.is_file():
            return str(p)
    return None


def _stop() -> None:
    global _proc, _tmp, _log
    if _proc is not None:
        _proc.terminate()
        try:
            _proc.wait(10)
        except subprocess.TimeoutExpired:
            _proc.kill()
        _proc = None
    if _log is not None:
        _log.close()
        _log = None
    if _tmp is not None:
        shutil.rmtree(_tmp, ignore_errors=True)
        _tmp = None


def reactor() -> Tuple[str, Optional[str]]:
    """Returns ``(base_url, token)``; raises SkipTest when no reactor is available."""
    global _state, _proc, _tmp, _skip_reason, _log
    if _state is not None:
        return _state
    if _skip_reason is not None:
        raise unittest.SkipTest(_skip_reason)
    url = os.environ.get("REACTOR_URL")
    if url:
        _state = (url.rstrip("/"), os.environ.get("REACTOR_TOKEN") or None)
        return _state
    binary = os.environ.get("REACTOR_BIN") or _default_bin()
    if not binary or not os.path.isfile(binary):
        _skip_reason = "no reactor: set REACTOR_BIN or REACTOR_URL"
        raise unittest.SkipTest(_skip_reason)
    token = os.environ.get("REACTOR_TOKEN") or "test-" + secrets.token_hex(8)
    port = _free_port()
    _tmp = tempfile.mkdtemp(prefix="datran-py-")
    env = dict(os.environ, REACTOR_PORT=str(port), REACTOR_TOKEN=token, REACTOR_STATE_DIR=_tmp,
               REACTOR_BIND="127.0.0.1")
    env.pop("REACTOR_CLUSTER_TOKEN", None)
    _log = open(os.path.join(_tmp, "reactor.log"), "wb")
    _proc = subprocess.Popen([binary], env=env, stdout=_log, stderr=subprocess.STDOUT)
    atexit.register(_stop)
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 30
    while time.time() < deadline:
        if _proc.poll() is not None:
            _skip_reason = f"reactor exited early with code {_proc.returncode}"
            raise RuntimeError(_skip_reason)
        try:
            with urllib.request.urlopen(base + "/health", timeout=1) as r:
                if r.status == 200:
                    _state = (base, token)
                    return _state
        except OSError:
            time.sleep(0.1)
    _stop()
    raise RuntimeError("reactor did not become healthy within 30 s")


class Cluster:
    """Two (or more) reactors started from REACTOR_BIN that gossip with each other (data gravity)."""

    def __init__(self, urls, token, cluster_token, procs, dirs, logs):
        self.urls = urls
        self.token = token
        self.cluster_token = cluster_token
        self._procs = procs
        self._dirs = dirs
        self._logs = logs

    def stop(self) -> None:
        for p in self._procs:
            if p.poll() is None:
                p.terminate()
        for p in self._procs:
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        for f in self._logs:
            f.close()
        for d in self._dirs:
            shutil.rmtree(d, ignore_errors=True)
        self._procs = []


def start_cluster(n: int = 2, gossip_ms: int = 200, extra_env: Optional[dict] = None) -> Cluster:
    """Starts ``n`` reactors with REACTOR_PEERS pointing at each other; raises SkipTest without REACTOR_BIN.

    Defaults keep placement deterministic for tests: ``REACTOR_MIN_REPLICAS=1`` (no repair pulls) and a
    high ``REACTOR_GRAVITY_PULL`` (no demand pulls), so reads on a non-holder are remote reads.
    """
    if os.environ.get("REACTOR_URL") and not os.environ.get("REACTOR_BIN"):
        raise unittest.SkipTest("cluster tests need REACTOR_BIN (REACTOR_URL points at a single reactor)")
    binary = os.environ.get("REACTOR_BIN") or _default_bin()
    if not binary or not os.path.isfile(binary):
        raise unittest.SkipTest("no reactor: set REACTOR_BIN")
    token = "test-" + secrets.token_hex(8)
    ctoken = "cluster-" + secrets.token_hex(8)
    ports = [_free_port() for _ in range(n)]
    urls = [f"http://127.0.0.1:{p}" for p in ports]
    procs, dirs, logs = [], [], []
    cl = Cluster(urls, token, ctoken, procs, dirs, logs)
    try:
        for i, port in enumerate(ports):
            d = tempfile.mkdtemp(prefix=f"datran-py-c{i}-")
            dirs.append(d)
            env = dict(os.environ, REACTOR_PORT=str(port), REACTOR_TOKEN=token, REACTOR_STATE_DIR=d,
                       REACTOR_BIND="127.0.0.1", REACTOR_CLUSTER_TOKEN=ctoken,
                       REACTOR_PEERS=",".join(u for j, u in enumerate(urls) if j != i),
                       REACTOR_GOSSIP_INTERVAL_MS=str(gossip_ms), REACTOR_MIN_REPLICAS="1",
                       REACTOR_GRAVITY_PULL="1000000")
            env.update(extra_env or {})
            log = open(os.path.join(d, "reactor.log"), "wb")
            logs.append(log)
            procs.append(subprocess.Popen([binary], env=env, stdout=log, stderr=subprocess.STDOUT))
        deadline = time.time() + 30
        for p, u in zip(procs, urls):
            while True:
                if p.poll() is not None:
                    raise RuntimeError(f"reactor exited early with code {p.returncode}")
                try:
                    with urllib.request.urlopen(u + "/health", timeout=1) as r:
                        if r.status == 200:
                            break
                except OSError:
                    pass
                if time.time() > deadline:
                    raise RuntimeError("cluster did not become healthy within 30 s")
                time.sleep(0.1)
    except BaseException:
        cl.stop()
        raise
    return cl
