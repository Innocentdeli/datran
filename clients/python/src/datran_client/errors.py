"""Typed exceptions raised by :class:`datran_client.Client`."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional, Type

__all__ = [
    "DatranError",
    "TransportError",
    "ApiError",
    "BadRequestError",
    "AuthError",
    "NotFoundError",
    "MethodNotAllowedError",
    "PayloadTooLargeError",
    "RangeNotSatisfiableError",
    "InsufficientStorageError",
    "ServerError",
    "error_for_status",
]


class DatranError(Exception):
    """Base class of every error raised by this package."""


class TransportError(DatranError):
    """Connection refused/reset, DNS failure, timeout or malformed HTTP response."""


class ApiError(DatranError):
    """The reactor answered with a non-2xx status."""

    def __init__(self, status: int, message: str, body: bytes = b"", headers: Optional[Dict[str, str]] = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message
        self.body = body
        self.headers = headers or {}

    def json(self) -> Optional[Any]:
        try:
            return json.loads(self.body.decode("utf-8"))
        except Exception:
            return None


class BadRequestError(ApiError):
    """400: invalid blob, output limit exceeded, invalid id, unknown dictionary (see ``unknown_dict``)."""

    @property
    def unknown_dict(self) -> Optional[str]:
        j = self.json()
        return j.get("unknown_dict") if isinstance(j, dict) else None


class AuthError(ApiError):
    """401: missing or invalid token."""


class NotFoundError(ApiError):
    """404: unknown file or route (e.g. ``/store/*`` on a reactor built without the store)."""


class MethodNotAllowedError(ApiError):
    """405."""


class PayloadTooLargeError(ApiError):
    """413: body over the reactor's 500 MiB limit."""


class RangeNotSatisfiableError(ApiError):
    """416: the requested range lies outside the file. ``size`` is parsed from ``Content-Range: bytes */size``."""

    @property
    def size(self) -> Optional[int]:
        cr = self.headers.get("content-range", "")
        if "/" in cr:
            try:
                return int(cr.rsplit("/", 1)[1])
            except ValueError:
                return None
        return None


class InsufficientStorageError(ApiError):
    """507: the store is over capacity and nothing can be evicted.

    Body: ``{"error": "store full", "needed": int, "used": int, "max": int}`` (physical bytes).
    """

    def _field(self, k: str) -> Optional[int]:
        j = self.json()
        v = j.get(k) if isinstance(j, dict) else None
        return v if isinstance(v, int) and not isinstance(v, bool) else None

    @property
    def needed(self) -> Optional[int]:
        """Physical bytes the upload needed."""
        return self._field("needed")

    @property
    def used(self) -> Optional[int]:
        """Physical bytes of live objects."""
        return self._field("used")

    @property
    def max(self) -> Optional[int]:
        """Configured ``REACTOR_STORE_MAX_BYTES``."""
        return self._field("max")


class ServerError(ApiError):
    """Any 5xx other than 507 (``503 {"error":"object store disabled"}`` when the store is off)."""


_BY_STATUS: Dict[int, Type[ApiError]] = {
    400: BadRequestError,
    401: AuthError,
    404: NotFoundError,
    405: MethodNotAllowedError,
    413: PayloadTooLargeError,
    416: RangeNotSatisfiableError,
    507: InsufficientStorageError,
}


def error_for_status(status: int, body: bytes, headers: Dict[str, str]) -> ApiError:
    message = ""
    try:
        j = json.loads(body.decode("utf-8")) if body else None
        if isinstance(j, dict) and isinstance(j.get("error"), str):
            message = j["error"]
    except Exception:
        pass
    if not message:
        message = body[:300].decode("utf-8", "replace") if body else _reason(status)
    cls = _BY_STATUS.get(status)
    if cls is None:
        cls = ServerError if status >= 500 else ApiError
    return cls(status, message, body, headers)


def _reason(status: int) -> str:
    try:
        from http import HTTPStatus

        return HTTPStatus(status).phrase
    except ValueError:
        return "error"
