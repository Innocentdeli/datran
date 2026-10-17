import type { StoreFull } from "./types.js";

/** Base class of every error thrown by this package. */
export class DatranError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Connection failure, timeout, abort or malformed response. */
export class TransportError extends DatranError {}

/** The reactor answered with a non-2xx status. */
export class ApiError extends DatranError {
  readonly status: number;
  /** `error` field of the JSON body, or a short text/status phrase. */
  readonly serverMessage: string;
  readonly body: Uint8Array;
  readonly headers: Headers;

  constructor(status: number, serverMessage: string, body: Uint8Array, headers: Headers) {
    super(`HTTP ${status}: ${serverMessage}`);
    this.status = status;
    this.serverMessage = serverMessage;
    this.body = body;
    this.headers = headers;
  }

  /** Parsed JSON body, or undefined. */
  json(): unknown {
    try {
      return JSON.parse(new TextDecoder().decode(this.body));
    } catch {
      return undefined;
    }
  }
}

/** 400: invalid/corrupt blob, output limit, invalid id, unknown dictionary. */
export class BadRequestError extends ApiError {
  /** SHA-256 of the missing dictionary when the blob references one the reactor lacks. */
  get unknownDict(): string | undefined {
    const j = this.json() as { unknown_dict?: unknown } | undefined;
    return typeof j?.unknown_dict === "string" ? j.unknown_dict : undefined;
  }
}
/** 401: missing or invalid token. */
export class AuthError extends ApiError {}
/** 404: unknown id or route (e.g. `/store/*` on a reactor built without the store). */
export class NotFoundError extends ApiError {}
/** 405. */
export class MethodNotAllowedError extends ApiError {}
/** 413: body over the 500 MiB limit. */
export class PayloadTooLargeError extends ApiError {}
/** 416: range outside the file. */
export class RangeNotSatisfiableError extends ApiError {
  /** File size from `Content-Range: bytes * /size`, when sent. */
  get size(): number | undefined {
    const m = /\/(\d+)\s*$/.exec(this.headers.get("content-range") ?? "");
    return m ? Number(m[1]) : undefined;
  }
}
/** 507: store over capacity, nothing evictable. */
export class InsufficientStorageError extends ApiError {
  /** `{error:"store full", needed, used, max}` body, when present. */
  get storeFull(): StoreFull | undefined {
    const j = this.json() as Partial<StoreFull> | undefined;
    if (!j || typeof j.needed !== "number" || typeof j.used !== "number" || typeof j.max !== "number") return undefined;
    return j as StoreFull;
  }
}
/** Other 5xx (503 `object store disabled` when the store is off). */
export class ServerError extends ApiError {}

const BY_STATUS: Record<number, typeof ApiError> = {
  400: BadRequestError,
  401: AuthError,
  404: NotFoundError,
  405: MethodNotAllowedError,
  413: PayloadTooLargeError,
  416: RangeNotSatisfiableError,
  507: InsufficientStorageError,
};

export function errorForStatus(status: number, body: Uint8Array, headers: Headers, statusText = ""): ApiError {
  let message = "";
  if (body.length > 0) {
    const text = new TextDecoder().decode(body);
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j?.error === "string") message = j.error;
    } catch {
      /* not JSON */
    }
    if (!message) message = text.slice(0, 300);
  }
  if (!message) message = statusText || "error";
  const Cls = BY_STATUS[status] ?? (status >= 500 ? ServerError : ApiError);
  return new Cls(status, message, body, headers);
}
