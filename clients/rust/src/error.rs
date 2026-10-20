use bytes::Bytes;

/// Classification of a non-2xx reactor response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// 400: invalid/corrupt blob, output limit, invalid id, unknown dictionary.
    BadRequest,
    /// 401: missing or invalid token.
    Unauthorized,
    /// 404: unknown id or route (e.g. `/store/*` on a reactor built without the store).
    NotFound,
    /// 405.
    MethodNotAllowed,
    /// 413: body over the 500 MiB limit.
    PayloadTooLarge,
    /// 416: range outside the file.
    RangeNotSatisfiable,
    /// 507: store over capacity, nothing evictable.
    InsufficientStorage,
    /// Any other 5xx (503 `object store disabled` when the store is off).
    Server,
    /// Any other status.
    Other,
}

impl ErrorKind {
    pub fn from_status(status: u16) -> ErrorKind {
        match status {
            400 => ErrorKind::BadRequest,
            401 => ErrorKind::Unauthorized,
            404 => ErrorKind::NotFound,
            405 => ErrorKind::MethodNotAllowed,
            413 => ErrorKind::PayloadTooLarge,
            416 => ErrorKind::RangeNotSatisfiable,
            507 => ErrorKind::InsufficientStorage,
            s if s >= 500 => ErrorKind::Server,
            _ => ErrorKind::Other,
        }
    }
}

/// A non-2xx response from the reactor.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub kind: ErrorKind,
    /// `error` field of the JSON body, or a short text / status phrase.
    pub message: String,
    pub body: Bytes,
    /// `Content-Range` (416 responses carry `bytes */size`).
    pub content_range: Option<String>,
}

impl ApiError {
    pub(crate) fn new(status: u16, body: Bytes, content_range: Option<String>) -> ApiError {
        let mut message = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or_default();
        if message.is_empty() {
            message = String::from_utf8_lossy(&body[..body.len().min(300)]).into_owned();
        }
        if message.is_empty() {
            message = reqwest::StatusCode::from_u16(status)
                .ok()
                .and_then(|s| s.canonical_reason())
                .unwrap_or("error")
                .to_owned();
        }
        ApiError {
            status,
            kind: ErrorKind::from_status(status),
            message,
            body,
            content_range,
        }
    }

    /// SHA-256 of a dictionary the reactor does not have (400 from `/decompress`).
    pub fn unknown_dict(&self) -> Option<String> {
        serde_json::from_slice::<serde_json::Value>(&self.body)
            .ok()?
            .get("unknown_dict")?
            .as_str()
            .map(str::to_owned)
    }

    /// File size from a 416 `Content-Range: bytes */size`.
    pub fn range_total(&self) -> Option<u64> {
        self.content_range
            .as_deref()?
            .rsplit('/')
            .next()?
            .trim()
            .parse()
            .ok()
    }

    /// `{error:"store full", needed, used, max}` of a 507 from `PUT /store/files`.
    pub fn store_full(&self) -> Option<crate::StoreFull> {
        if self.status != 507 {
            return None;
        }
        serde_json::from_slice(&self.body).ok()
    }
}

/// Every error returned by this crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Connection failure, TLS error, timeout or broken body stream.
    #[error("transport error: {0}")]
    Transport(#[source] reqwest::Error),
    /// The reactor answered with a non-2xx status.
    #[error("HTTP {}: {}", .0.status, .0.message)]
    Api(ApiError),
    /// Local I/O (reading an upload source or writing a download sink).
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// The response could not be interpreted (bad JSON, truncated body, bad Content-Range…).
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    /// Bad caller input (e.g. an invalid base URL or range).
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Transport(e)
    }
}

impl Error {
    /// HTTP status of an [`Error::Api`].
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api(e) => Some(e.status),
            _ => None,
        }
    }

    /// Kind of an [`Error::Api`].
    pub fn kind(&self) -> Option<ErrorKind> {
        match self {
            Error::Api(e) => Some(e.kind),
            _ => None,
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.kind() == Some(ErrorKind::NotFound)
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, Error::Transport(e) if e.is_timeout())
    }

    pub fn api(&self) -> Option<&ApiError> {
        match self {
            Error::Api(e) => Some(e),
            _ => None,
        }
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
