// datran/client.hpp - header-only C++17 client for the Datran core reactor.
//
// No external dependencies: a minimal HTTP/1.1 client over Winsock (Windows) or BSD sockets (POSIX).
// Plain HTTP only - for TLS put a TLS-terminating proxy (e.g. stunnel, nginx, Caddy) in front.
// One connection per request (`Connection: close`). Responses: Content-Length, chunked, or read-to-close.
//
// Windows: link ws2_32 (CMake target `datran::client` does this).
//
// API mirrors core-reactor/openapi.yaml; see README.md.
#pragma once

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <istream>
#include <map>
#include <memory>
#include <optional>
#include <ostream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#ifdef _MSC_VER
#pragma comment(lib, "ws2_32.lib")
#endif
#else
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace datran {

// =====================================================================================  JSON

namespace json {

/// Minimal JSON value (parse + dump) sufficient for reactor responses.
class Value {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };
    using Array = std::vector<Value>;
    using Object = std::map<std::string, Value>;

    Value() = default;
    Value(std::nullptr_t) {}
    Value(bool b) : type_(Type::Bool), b_(b) {}
    Value(double d) : type_(Type::Number), n_(d) {}
    Value(std::string s) : type_(Type::String), s_(std::make_shared<std::string>(std::move(s))) {}
    Value(Array a) : type_(Type::Array), a_(std::make_shared<Array>(std::move(a))) {}
    Value(Object o) : type_(Type::Object), o_(std::make_shared<Object>(std::move(o))) {}

    Type type() const { return type_; }
    bool is_null() const { return type_ == Type::Null; }
    bool is_bool() const { return type_ == Type::Bool; }
    bool is_number() const { return type_ == Type::Number; }
    bool is_string() const { return type_ == Type::String; }
    bool is_array() const { return type_ == Type::Array; }
    bool is_object() const { return type_ == Type::Object; }

    bool as_bool(bool d = false) const { return is_bool() ? b_ : d; }
    double as_number(double d = 0) const { return is_number() ? n_ : d; }
    std::int64_t as_i64(std::int64_t d = 0) const { return is_number() ? static_cast<std::int64_t>(n_) : d; }
    std::uint64_t as_u64(std::uint64_t d = 0) const {
        return is_number() && n_ >= 0 ? static_cast<std::uint64_t>(n_) : d;
    }
    const std::string& as_string() const {
        static const std::string empty;
        return is_string() ? *s_ : empty;
    }
    const Array& as_array() const {
        static const Array empty;
        return is_array() ? *a_ : empty;
    }
    const Object& as_object() const {
        static const Object empty;
        return is_object() ? *o_ : empty;
    }
    /// Object member or null.
    const Value& operator[](const std::string& k) const {
        static const Value null;
        if (!is_object()) return null;
        auto it = o_->find(k);
        return it == o_->end() ? null : it->second;
    }
    /// Array element or null.
    const Value& operator[](std::size_t i) const {
        static const Value null;
        return is_array() && i < a_->size() ? (*a_)[i] : null;
    }
    bool contains(const std::string& k) const { return is_object() && o_->count(k) > 0; }
    std::size_t size() const { return is_array() ? a_->size() : is_object() ? o_->size() : 0; }

    std::string dump() const {
        std::string out;
        dump_to(out);
        return out;
    }

    static Value parse(const std::string& text) {
        Parser p{text, 0};
        p.ws();
        Value v = p.value(0);
        p.ws();
        if (p.i != text.size()) throw std::runtime_error("json: trailing characters");
        return v;
    }

private:
    Type type_ = Type::Null;
    bool b_ = false;
    double n_ = 0;
    std::shared_ptr<std::string> s_;
    std::shared_ptr<Array> a_;
    std::shared_ptr<Object> o_;

    static void dump_str(std::string& out, const std::string& s) {
        out += '"';
        for (unsigned char c : s) {
            switch (c) {
                case '"': out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (c < 0x20) {
                        char buf[8];
                        std::snprintf(buf, sizeof buf, "\\u%04x", c);
                        out += buf;
                    } else {
                        out += static_cast<char>(c);
                    }
            }
        }
        out += '"';
    }

    void dump_to(std::string& out) const {
        switch (type_) {
            case Type::Null: out += "null"; break;
            case Type::Bool: out += b_ ? "true" : "false"; break;
            case Type::Number: {
                char buf[32];
                if (std::isfinite(n_) && n_ == std::floor(n_) && std::fabs(n_) < 9.007199254740992e15)
                    std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(n_));
                else
                    std::snprintf(buf, sizeof buf, "%.17g", n_);
                out += buf;
                break;
            }
            case Type::String: dump_str(out, *s_); break;
            case Type::Array: {
                out += '[';
                bool first = true;
                for (auto& v : *a_) {
                    if (!first) out += ',';
                    first = false;
                    v.dump_to(out);
                }
                out += ']';
                break;
            }
            case Type::Object: {
                out += '{';
                bool first = true;
                for (auto& kv : *o_) {
                    if (!first) out += ',';
                    first = false;
                    dump_str(out, kv.first);
                    out += ':';
                    kv.second.dump_to(out);
                }
                out += '}';
                break;
            }
        }
    }

    struct Parser {
        const std::string& s;
        std::size_t i;

        [[noreturn]] void fail(const char* what) const {
            throw std::runtime_error(std::string("json: ") + what + " at offset " + std::to_string(i));
        }
        void ws() {
            while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
        }
        bool lit(const char* w) {
            std::size_t n = std::strlen(w);
            if (s.compare(i, n, w) == 0) {
                i += n;
                return true;
            }
            return false;
        }
        Value value(int depth) {
            if (depth > 256) fail("nesting too deep");
            if (i >= s.size()) fail("unexpected end");
            char c = s[i];
            if (c == '{') {
                ++i;
                Object o;
                ws();
                if (i < s.size() && s[i] == '}') {
                    ++i;
                    return Value(std::move(o));
                }
                for (;;) {
                    ws();
                    if (i >= s.size() || s[i] != '"') fail("expected key");
                    std::string k = str();
                    ws();
                    if (i >= s.size() || s[i] != ':') fail("expected ':'");
                    ++i;
                    ws();
                    o[k] = value(depth + 1);
                    ws();
                    if (i < s.size() && s[i] == ',') {
                        ++i;
                        continue;
                    }
                    if (i < s.size() && s[i] == '}') {
                        ++i;
                        return Value(std::move(o));
                    }
                    fail("expected ',' or '}'");
                }
            }
            if (c == '[') {
                ++i;
                Array a;
                ws();
                if (i < s.size() && s[i] == ']') {
                    ++i;
                    return Value(std::move(a));
                }
                for (;;) {
                    ws();
                    a.push_back(value(depth + 1));
                    ws();
                    if (i < s.size() && s[i] == ',') {
                        ++i;
                        continue;
                    }
                    if (i < s.size() && s[i] == ']') {
                        ++i;
                        return Value(std::move(a));
                    }
                    fail("expected ',' or ']'");
                }
            }
            if (c == '"') return Value(str());
            if (lit("true")) return Value(true);
            if (lit("false")) return Value(false);
            if (lit("null")) return Value();
            if (c == '-' || (c >= '0' && c <= '9')) {
                std::size_t st = i;
                if (s[i] == '-') ++i;
                while (i < s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '.' || s[i] == 'e' ||
                                        s[i] == 'E' || s[i] == '+' || s[i] == '-'))
                    ++i;
                std::string num = s.substr(st, i - st);
                char* end = nullptr;
                double d = std::strtod(num.c_str(), &end);
                if (!end || *end) fail("bad number");
                return Value(d);
            }
            fail("unexpected character");
        }
        static void utf8(std::string& out, unsigned cp) {
            if (cp < 0x80) {
                out += static_cast<char>(cp);
            } else if (cp < 0x800) {
                out += static_cast<char>(0xC0 | (cp >> 6));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else if (cp < 0x10000) {
                out += static_cast<char>(0xE0 | (cp >> 12));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else {
                out += static_cast<char>(0xF0 | (cp >> 18));
                out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            }
        }
        unsigned hex4() {
            if (i + 4 > s.size()) fail("bad \\u escape");
            unsigned v = 0;
            for (int k = 0; k < 4; ++k) {
                char h = s[i++];
                v <<= 4;
                if (h >= '0' && h <= '9') v |= static_cast<unsigned>(h - '0');
                else if (h >= 'a' && h <= 'f') v |= static_cast<unsigned>(h - 'a' + 10);
                else if (h >= 'A' && h <= 'F') v |= static_cast<unsigned>(h - 'A' + 10);
                else fail("bad hex digit");
            }
            return v;
        }
        std::string str() {
            ++i;  // opening quote
            std::string out;
            while (i < s.size()) {
                char c = s[i++];
                if (c == '"') return out;
                if (c != '\\') {
                    out += c;
                    continue;
                }
                if (i >= s.size()) break;
                char e = s[i++];
                switch (e) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u': {
                        unsigned cp = hex4();
                        if (cp >= 0xD800 && cp < 0xDC00 && i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                            i += 2;
                            unsigned lo = hex4();
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        }
                        utf8(out, cp);
                        break;
                    }
                    default: fail("bad escape");
                }
            }
            fail("unterminated string");
        }
    };
};

}  // namespace json

// =====================================================================================  errors

/// Base of every error thrown by this library.
class Error : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

/// Connection failure, timeout or malformed HTTP response.
class TransportError : public Error {
public:
    explicit TransportError(const std::string& m, bool timeout = false) : Error(m), timeout_(timeout) {}
    bool is_timeout() const { return timeout_; }

private:
    bool timeout_;
};

/// Invalid caller input (bad URL, bad range...).
class ArgumentError : public Error {
public:
    using Error::Error;
};

enum class ErrorKind {
    BadRequest,           // 400
    Unauthorized,         // 401
    NotFound,             // 404
    MethodNotAllowed,     // 405
    PayloadTooLarge,      // 413
    RangeNotSatisfiable,  // 416
    InsufficientStorage,  // 507
    Server,               // other 5xx
    Other
};

inline ErrorKind error_kind_for(int status) {
    switch (status) {
        case 400: return ErrorKind::BadRequest;
        case 401: return ErrorKind::Unauthorized;
        case 404: return ErrorKind::NotFound;
        case 405: return ErrorKind::MethodNotAllowed;
        case 413: return ErrorKind::PayloadTooLarge;
        case 416: return ErrorKind::RangeNotSatisfiable;
        case 507: return ErrorKind::InsufficientStorage;
        default: return status >= 500 ? ErrorKind::Server : ErrorKind::Other;
    }
}

/// Lower-cased header names.
using Headers = std::map<std::string, std::string>;

/// Body of a 507 from PUT /store/files: {"error":"store full", needed, used, max} (see ApiError::store_full()).
struct StoreFull {
    std::uint64_t needed = 0;  ///< physical bytes the upload needed
    std::uint64_t used = 0;    ///< physical bytes of live objects
    std::uint64_t max = 0;     ///< REACTOR_STORE_MAX_BYTES
};

/// Non-2xx response.
class ApiError : public Error {
public:
    ApiError(int status, std::string message, std::string body, Headers headers)
        : Error("HTTP " + std::to_string(status) + ": " + message),
          status_(status),
          kind_(error_kind_for(status)),
          message_(std::move(message)),
          body_(std::move(body)),
          headers_(std::move(headers)) {}

    int status() const { return status_; }
    ErrorKind kind() const { return kind_; }
    /// `error` field of the JSON body, or a short text.
    const std::string& server_message() const { return message_; }
    const std::string& body() const { return body_; }
    const Headers& headers() const { return headers_; }

    /// Missing dictionary id (400 from /decompress), or empty.
    std::string unknown_dict() const {
        try {
            return json::Value::parse(body_)["unknown_dict"].as_string();
        } catch (...) {
            return {};
        }
    }
    /// Size from a 416 `Content-Range: bytes */size`, or nullopt.
    std::optional<std::uint64_t> range_total() const {
        auto it = headers_.find("content-range");
        if (it == headers_.end()) return std::nullopt;
        auto p = it->second.rfind('/');
        if (p == std::string::npos) return std::nullopt;
        try {
            return std::stoull(it->second.substr(p + 1));
        } catch (...) {
            return std::nullopt;
        }
    }
    /// Parsed 507 body from PUT /store/files, or nullopt.
    std::optional<StoreFull> store_full() const {
        if (status_ != 507) return std::nullopt;
        try {
            auto j = json::Value::parse(body_);
            if (!j["needed"].is_number() || !j["used"].is_number() || !j["max"].is_number()) return std::nullopt;
            return StoreFull{j["needed"].as_u64(), j["used"].as_u64(), j["max"].as_u64()};
        } catch (...) {
            return std::nullopt;
        }
    }

private:
    int status_;
    ErrorKind kind_;
    std::string message_;
    std::string body_;
    Headers headers_;
};

// =====================================================================================  public types

struct UploadOptions {
    std::string content_type;  ///< `x-content-type` hint (empty = none)
    bool no_sample = false;    ///< `x-reactor-no-sample: 1`
};

struct CompressMeta {
    std::string content_class;  ///< x-reactor-class
    json::Value recipe;         ///< parsed x-reactor-recipe (null for legacy raw)
    std::string format;         ///< x-reactor-format: v2 | legacy-raw
    std::uint64_t original_size = 0;
    std::uint64_t compressed_size = 0;
    std::string algo;
    double ratio = 0;
    std::uint64_t time_us = 0;
    double entropy = 0;
    std::string note;
    Headers headers;
};

struct CompressResult {
    CompressMeta meta;
    std::string data;
};

struct Entropy {
    std::uint64_t size_bytes = 0;
    double entropy_bits = 0;
    std::string suggested_routing;
};

/// PUT /store/files response.
struct PutResult {
    std::string file_id;
    std::uint64_t size = 0;
    std::uint64_t stored_bytes = 0;  ///< physical bytes of objects newly written by this upload
    std::uint64_t new_bytes = 0;     ///< plaintext bytes of the newly stored chunks (0 when duplicate);
                                     ///< compression of this upload = new_bytes / stored_bytes
    std::uint64_t new_chunks = 0;    ///< chunks not previously stored (0 when duplicate)
    std::uint64_t dedup_chunks = 0;  ///< chunks already stored (all chunks when duplicate)
    std::uint64_t chunks = 0;        ///< total chunks of the file
    std::string content_class;       ///< JSON "class", e.g. text/json, media/compressed, empty
    bool duplicate = false;          ///< already stored; only the pin count changed
    std::uint64_t pins = 0;          ///< pin count after this upload
    json::Value raw;
};

/// DELETE /store/files/{id} response.
struct DeleteResult {
    std::string file_id;
    std::uint64_t pins = 0;  ///< remaining pins (0 when deleted)
    bool deleted = false;    ///< manifest removed, tombstone written
    /// Node id of the peer the unpin was forwarded to (the file's origin holder) when this node did not
    /// hold the file itself (data gravity, NETWORK_SPEC §4).
    std::optional<std::string> forwarded_to;
};

struct StoreGcStats {
    std::uint64_t queue_objects = 0, queue_bytes = 0, grace_ms = 0, collected_objects = 0, collected_bytes = 0,
                  startup_orphans_removed = 0, startup_temp_files_removed = 0;
};

struct StoreFusionStats {
    bool enabled = false;
    std::uint64_t fusions = 0, unfusions = 0, bytes_saved = 0, reads_saved = 0, candidates_evaluated = 0, rejected = 0,
                  last_run_ms = 0, access_rows = 0;
    double coaccess_min = 0;
};

struct StoreScrubStats {
    std::uint64_t objects_checked = 0, bytes_checked = 0, corrupt_found = 0, passes_completed = 0,
                  pass_progress_objects = 0, last_step_ms = 0, last_pass_ms = 0, quarantined = 0;
};

/// Group commit of concurrent uploads (one index transaction per batch).
struct StoreGroupCommitStats {
    std::uint64_t batches = 0, jobs = 0, max_batch = 0;
    double window_ms = 0;
};

/// Data-gravity counters (/cluster/status `metrics` and /store/stats `cluster`).
struct ClusterMetrics {
    std::uint64_t gossip_rounds = 0, pulls = 0, pull_bytes = 0, pull_failures = 0, drops = 0, origin_transfers = 0,
                  repairs = 0, remote_reads = 0, remote_read_bytes = 0, remote_objects_fetched = 0,
                  remote_fetch_bytes = 0, remote_fetch_failures = 0, cache_hits = 0, cache_bytes = 0,
                  cache_objects = 0, tombstones_applied = 0, quarantine_repairs = 0, quarantine_repair_failures = 0,
                  leases_granted = 0, leases_refused = 0, leases_active = 0, evictions_confirmed = 0,
                  unpins_forwarded = 0;
};

/// GET /store/stats response (`raw` keeps the full JSON, including fields added later).
struct StoreStats {
    std::uint64_t files = 0, logical_bytes = 0, unique_bytes = 0, physical_bytes = 0, live_physical_bytes = 0;
    std::optional<std::uint64_t> max_bytes;  ///< REACTOR_STORE_MAX_BYTES; nullopt = unlimited
    double dedup_ratio = 0, compression_ratio = 0, total_ratio = 0;
    std::uint64_t objects = 0, super_chunks = 0, chunks = 0, tombstones = 0, inventory_version = 0, inflight_bytes = 0,
                  puts = 0, put_bytes = 0, reads = 0, read_bytes = 0, full_rejections = 0, evictions = 0;
    StoreGcStats gc;
    StoreFusionStats fusion;
    StoreScrubStats scrub;
    std::optional<StoreGroupCommitStats> group_commit;  ///< nullopt on reactors that predate it
    std::optional<ClusterMetrics> cluster;              ///< only when the cluster is enabled
    json::Value packs;                                  ///< pack-file stats (loose; null when absent)
    json::Value raw;
};

/// One configured peer as seen by this node.
struct ClusterPeer {
    std::string url;
    std::optional<std::string> node_id;  ///< nullopt until the first successful inventory fetch
    std::optional<std::string> region;
    bool healthy = false;  ///< last inventory fetch succeeded and is younger than 3 x the gossip interval
    bool is_self = false;  ///< the URL points back at this node
    std::optional<std::uint64_t> last_ok_ms;
    std::optional<std::string> last_error;
    std::optional<std::uint64_t> last_error_ms;
    std::uint64_t consecutive_failures = 0, inventory_version = 0;
    std::uint64_t files = 0;  ///< files the peer advertises
    std::optional<std::uint64_t> capacity;
    std::uint64_t used = 0;
};

/// Sampled replica placement.
struct FileHolders {
    std::string file_id;
    std::vector<std::string> holders;  ///< sorted; includes this node when `local`
    bool local = false;
    double demand = 0;  ///< local demand score
};

struct DemandEntry {
    std::string file_id;
    double score = 0;  ///< exponentially decayed request count
};

/// GET /cluster/status response (`raw` keeps the full JSON).
struct ClusterStatus {
    std::string node_id;
    std::optional<std::string> region;
    bool tls = false;                         ///< this node serves HTTPS
    std::uint64_t cluster_size = 0;           ///< this node plus its non-self peers
    std::uint64_t min_replicas = 0;           ///< REACTOR_MIN_REPLICAS
    std::uint64_t min_replicas_effective = 0; ///< min(min_replicas, cluster_size)
    double gravity_pull = 0;                  ///< REACTOR_GRAVITY_PULL
    std::uint64_t demand_half_life_ms = 0, gossip_interval_ms = 0;
    std::optional<std::uint64_t> capacity;    ///< REACTOR_STORE_MAX_BYTES (nullopt = unlimited)
    std::optional<std::uint64_t> used;        ///< live physical + in-flight bytes
    std::vector<ClusterPeer> peers;
    std::vector<FileHolders> holders_sample;
    std::vector<DemandEntry> demand_top;
    ClusterMetrics metrics;
    json::Value raw;

    /// The peer with this node id, or nullptr.
    const ClusterPeer* peer(const std::string& id) const {
        for (auto& p : peers)
            if (p.node_id && *p.node_id == id) return &p;
        return nullptr;
    }
};

namespace detail {

/// Strict field access for typed models; throws std::runtime_error naming the field.
inline const json::Value& field(const json::Value& j, const char* k) {
    if (!j.contains(k)) throw std::runtime_error(std::string("missing field '") + k + "'");
    return j[k];
}
inline std::uint64_t req_u64(const json::Value& j, const char* k) {
    const auto& v = field(j, k);
    double d = v.as_number(-1);
    if (!v.is_number() || d < 0 || d != std::floor(d)) throw std::runtime_error(std::string("field '") + k + "' is not an unsigned integer");
    return static_cast<std::uint64_t>(d);
}
inline double req_f64(const json::Value& j, const char* k) {
    const auto& v = field(j, k);
    if (!v.is_number()) throw std::runtime_error(std::string("field '") + k + "' is not a number");
    return v.as_number();
}
inline bool req_bool(const json::Value& j, const char* k) {
    const auto& v = field(j, k);
    if (!v.is_bool()) throw std::runtime_error(std::string("field '") + k + "' is not a boolean");
    return v.as_bool();
}
inline std::string req_str(const json::Value& j, const char* k) {
    const auto& v = field(j, k);
    if (!v.is_string()) throw std::runtime_error(std::string("field '") + k + "' is not a string");
    return v.as_string();
}
inline std::optional<std::uint64_t> opt_u64(const json::Value& j, const char* k) {
    if (field(j, k).is_null()) return std::nullopt;
    return req_u64(j, k);
}
inline const json::Value& req_obj(const json::Value& j, const char* k) {
    const auto& v = field(j, k);
    if (!v.is_object()) throw std::runtime_error(std::string("field '") + k + "' is not an object");
    return v;
}
inline const json::Value::Array& req_arr(const json::Value& j, const char* k) {
    const auto& v = field(j, k);
    if (!v.is_array()) throw std::runtime_error(std::string("field '") + k + "' is not an array");
    return v.as_array();
}
inline std::optional<std::string> opt_str(const json::Value& j, const char* k) {
    if (j[k].is_null()) return std::nullopt;  // absent or null
    return req_str(j, k);
}

inline ClusterMetrics parse_cluster_metrics(const json::Value& m) {
    ClusterMetrics r;
    struct F {
        const char* k;
        std::uint64_t ClusterMetrics::*p;
    };
    static const F fields[] = {
        {"gossip_rounds", &ClusterMetrics::gossip_rounds},
        {"pulls", &ClusterMetrics::pulls},
        {"pull_bytes", &ClusterMetrics::pull_bytes},
        {"pull_failures", &ClusterMetrics::pull_failures},
        {"drops", &ClusterMetrics::drops},
        {"origin_transfers", &ClusterMetrics::origin_transfers},
        {"repairs", &ClusterMetrics::repairs},
        {"remote_reads", &ClusterMetrics::remote_reads},
        {"remote_read_bytes", &ClusterMetrics::remote_read_bytes},
        {"remote_objects_fetched", &ClusterMetrics::remote_objects_fetched},
        {"remote_fetch_bytes", &ClusterMetrics::remote_fetch_bytes},
        {"remote_fetch_failures", &ClusterMetrics::remote_fetch_failures},
        {"cache_hits", &ClusterMetrics::cache_hits},
        {"cache_bytes", &ClusterMetrics::cache_bytes},
        {"cache_objects", &ClusterMetrics::cache_objects},
        {"tombstones_applied", &ClusterMetrics::tombstones_applied},
        {"quarantine_repairs", &ClusterMetrics::quarantine_repairs},
        {"quarantine_repair_failures", &ClusterMetrics::quarantine_repair_failures},
        {"leases_granted", &ClusterMetrics::leases_granted},
        {"leases_refused", &ClusterMetrics::leases_refused},
        {"leases_active", &ClusterMetrics::leases_active},
        {"evictions_confirmed", &ClusterMetrics::evictions_confirmed},
        {"unpins_forwarded", &ClusterMetrics::unpins_forwarded},
    };
    for (auto& f : fields) r.*(f.p) = req_u64(m, f.k);
    return r;
}

}  // namespace detail

/// Parses a PUT /store/files body (throws std::runtime_error on a shape mismatch).
inline PutResult parse_put_result(const json::Value& j) {
    using namespace detail;
    PutResult r;
    r.file_id = req_str(j, "file_id");
    r.size = req_u64(j, "size");
    r.stored_bytes = req_u64(j, "stored_bytes");
    r.new_bytes = req_u64(j, "new_bytes");
    r.new_chunks = req_u64(j, "new_chunks");
    r.dedup_chunks = req_u64(j, "dedup_chunks");
    r.chunks = req_u64(j, "chunks");
    r.content_class = req_str(j, "class");
    r.duplicate = req_bool(j, "duplicate");
    r.pins = req_u64(j, "pins");
    r.raw = j;
    return r;
}

inline DeleteResult parse_delete_result(const json::Value& j) {
    using namespace detail;
    return DeleteResult{req_str(j, "file_id"), req_u64(j, "pins"), req_bool(j, "deleted"), opt_str(j, "forwarded_to")};
}

/// Parses a GET /cluster/status body (throws std::runtime_error on a shape mismatch).
inline ClusterStatus parse_cluster_status(const json::Value& j) {
    using namespace detail;
    ClusterStatus s;
    s.node_id = req_str(j, "node_id");
    s.region = opt_str(j, "region");
    s.tls = req_bool(j, "tls");
    s.cluster_size = req_u64(j, "cluster_size");
    s.min_replicas = req_u64(j, "min_replicas");
    s.min_replicas_effective = req_u64(j, "min_replicas_effective");
    s.gravity_pull = req_f64(j, "gravity_pull");
    s.demand_half_life_ms = req_u64(j, "demand_half_life_ms");
    s.gossip_interval_ms = req_u64(j, "gossip_interval_ms");
    s.capacity = opt_u64(j, "capacity");
    s.used = opt_u64(j, "used");
    for (auto& p : req_arr(j, "peers")) {
        ClusterPeer cp;
        cp.url = req_str(p, "url");
        cp.node_id = opt_str(p, "node_id");
        cp.region = opt_str(p, "region");
        cp.healthy = req_bool(p, "healthy");
        cp.is_self = req_bool(p, "is_self");
        cp.last_ok_ms = opt_u64(p, "last_ok_ms");
        cp.last_error = opt_str(p, "last_error");
        cp.last_error_ms = opt_u64(p, "last_error_ms");
        cp.consecutive_failures = req_u64(p, "consecutive_failures");
        cp.inventory_version = req_u64(p, "inventory_version");
        cp.files = req_u64(p, "files");
        cp.capacity = opt_u64(p, "capacity");
        cp.used = req_u64(p, "used");
        s.peers.push_back(std::move(cp));
    }
    for (auto& h : req_arr(j, "holders_sample")) {
        FileHolders fh;
        fh.file_id = req_str(h, "file_id");
        for (auto& n : req_arr(h, "holders")) {
            if (!n.is_string()) throw std::runtime_error("field 'holders' must contain strings");
            fh.holders.push_back(n.as_string());
        }
        fh.local = req_bool(h, "local");
        fh.demand = req_f64(h, "demand");
        s.holders_sample.push_back(std::move(fh));
    }
    for (auto& d : req_arr(j, "demand_top")) s.demand_top.push_back(DemandEntry{req_str(d, "file_id"), req_f64(d, "score")});
    s.metrics = parse_cluster_metrics(req_obj(j, "metrics"));
    s.raw = j;
    return s;
}

inline StoreStats parse_store_stats(const json::Value& j) {
    using namespace detail;
    StoreStats s;
    s.files = req_u64(j, "files");
    s.logical_bytes = req_u64(j, "logical_bytes");
    s.unique_bytes = req_u64(j, "unique_bytes");
    s.physical_bytes = req_u64(j, "physical_bytes");
    s.live_physical_bytes = req_u64(j, "live_physical_bytes");
    s.max_bytes = opt_u64(j, "max_bytes");
    s.dedup_ratio = req_f64(j, "dedup_ratio");
    s.compression_ratio = req_f64(j, "compression_ratio");
    s.total_ratio = req_f64(j, "total_ratio");
    s.objects = req_u64(j, "objects");
    s.super_chunks = req_u64(j, "super_chunks");
    s.chunks = req_u64(j, "chunks");
    s.tombstones = req_u64(j, "tombstones");
    s.inventory_version = req_u64(j, "inventory_version");
    s.inflight_bytes = req_u64(j, "inflight_bytes");
    s.puts = req_u64(j, "puts");
    s.put_bytes = req_u64(j, "put_bytes");
    s.reads = req_u64(j, "reads");
    s.read_bytes = req_u64(j, "read_bytes");
    s.full_rejections = req_u64(j, "full_rejections");
    s.evictions = req_u64(j, "evictions");
    const auto& g = req_obj(j, "gc");
    s.gc = StoreGcStats{req_u64(g, "queue_objects"),     req_u64(g, "queue_bytes"),
                        req_u64(g, "grace_ms"),          req_u64(g, "collected_objects"),
                        req_u64(g, "collected_bytes"),   req_u64(g, "startup_orphans_removed"),
                        req_u64(g, "startup_temp_files_removed")};
    const auto& f = req_obj(j, "fusion");
    s.fusion.enabled = req_bool(f, "enabled");
    s.fusion.fusions = req_u64(f, "fusions");
    s.fusion.unfusions = req_u64(f, "unfusions");
    s.fusion.bytes_saved = req_u64(f, "bytes_saved");
    s.fusion.reads_saved = req_u64(f, "reads_saved");
    s.fusion.candidates_evaluated = req_u64(f, "candidates_evaluated");
    s.fusion.rejected = req_u64(f, "rejected");
    s.fusion.last_run_ms = req_u64(f, "last_run_ms");
    s.fusion.access_rows = req_u64(f, "access_rows");
    s.fusion.coaccess_min = req_f64(f, "coaccess_min");
    const auto& c = req_obj(j, "scrub");
    s.scrub = StoreScrubStats{req_u64(c, "objects_checked"),  req_u64(c, "bytes_checked"),
                              req_u64(c, "corrupt_found"),    req_u64(c, "passes_completed"),
                              req_u64(c, "pass_progress_objects"), req_u64(c, "last_step_ms"),
                              req_u64(c, "last_pass_ms"),     req_u64(c, "quarantined")};
    if (!j["group_commit"].is_null()) {
        const auto& gc = req_obj(j, "group_commit");
        s.group_commit = StoreGroupCommitStats{req_u64(gc, "batches"), req_u64(gc, "jobs"), req_u64(gc, "max_batch"),
                                               req_f64(gc, "window_ms")};
    }
    if (!j["cluster"].is_null()) s.cluster = parse_cluster_metrics(req_obj(j, "cluster"));
    if (!j["packs"].is_null()) s.packs = req_obj(j, "packs");
    s.raw = j;
    return s;
}

struct RangeInfo {
    int status = 0;  ///< 200 or 206
    std::uint64_t start = 0;
    std::optional<std::uint64_t> end;    ///< inclusive; nullopt for empty body
    std::optional<std::uint64_t> total;  ///< full file size when known
    std::uint64_t length = 0;            ///< bytes received
    std::string etag;                    ///< strong ETag (quoted lowercase file id), empty if absent
    Headers headers;
};

struct GetResult {
    RangeInfo info;
    std::string data;
};

struct HeadResult {
    std::uint64_t size = 0;
    std::string accept_ranges;
    std::string etag;  ///< strong ETag (quoted lowercase file id), empty if absent
};

/// Single byte range for store reads.
struct ByteRange {
    enum class Kind { From, Span, Suffix } kind = Kind::From;
    std::uint64_t a = 0, b = 0;
    static ByteRange from(std::uint64_t start) { return {Kind::From, start, 0}; }
    static ByteRange span(std::uint64_t start, std::uint64_t end_inclusive) { return {Kind::Span, start, end_inclusive}; }
    static ByteRange suffix(std::uint64_t n) { return {Kind::Suffix, n, 0}; }
    std::string header_value() const {
        switch (kind) {
            case Kind::From: return "bytes=" + std::to_string(a) + "-";
            case Kind::Span:
                if (b < a) throw ArgumentError("invalid range: end < start");
                return "bytes=" + std::to_string(a) + "-" + std::to_string(b);
            case Kind::Suffix:
                if (a == 0) throw ArgumentError("invalid range: empty suffix");
                return "bytes=-" + std::to_string(a);
        }
        return {};
    }
};

/// Receives response body bytes as they arrive.
using Sink = std::function<void(const char* data, std::size_t len)>;
/// Supplies request body bytes: fill `buf` (up to `cap`), return bytes written; 0 = end.
using Source = std::function<std::size_t(char* buf, std::size_t cap)>;

// =====================================================================================  HTTP internals

namespace detail {

inline std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

inline std::string trim(const std::string& s) {
    std::size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r')) --b;
    return s.substr(a, b - a);
}

/// Parses `bytes start-end/total` (total may be `*`).
inline bool parse_content_range(const std::string& v, std::uint64_t& start, std::uint64_t& end,
                                std::optional<std::uint64_t>& total) {
    std::string t = trim(v);
    if (t.compare(0, 6, "bytes ") != 0) return false;
    t = trim(t.substr(6));
    auto dash = t.find('-'), slash = t.find('/');
    if (dash == std::string::npos || slash == std::string::npos || dash > slash) return false;
    try {
        std::size_t used = 0;
        start = std::stoull(t.substr(0, dash), &used);
        end = std::stoull(t.substr(dash + 1, slash - dash - 1), &used);
        std::string tot = trim(t.substr(slash + 1));
        if (tot == "*") total.reset();
        else total = std::stoull(tot);
    } catch (...) {
        return false;
    }
    return true;
}

/// Byte source for the response parser (sockets in production, strings in tests).
class Reader {
public:
    virtual ~Reader() = default;
    /// Reads up to `cap` bytes; returns 0 at EOF; throws TransportError on error/timeout.
    virtual std::size_t read_some(char* buf, std::size_t cap) = 0;
};

class StringReader : public Reader {
public:
    explicit StringReader(std::string s, std::size_t step = 7) : s_(std::move(s)), step_(step) {}
    std::size_t read_some(char* buf, std::size_t cap) override {
        std::size_t n = std::min({cap, step_, s_.size() - pos_});
        std::memcpy(buf, s_.data() + pos_, n);
        pos_ += n;
        return n;
    }

private:
    std::string s_;
    std::size_t step_;
    std::size_t pos_ = 0;
};

/// Buffered reader with line/exact reads.
class BufReader {
public:
    explicit BufReader(Reader& r) : r_(r) {}

    bool fill() {
        if (pos_ < len_) return true;
        len_ = r_.read_some(buf_, sizeof buf_);
        pos_ = 0;
        return len_ > 0;
    }
    /// Reads a CRLF/LF-terminated line (without terminator). Limits line length.
    std::string line(std::size_t max = 64 * 1024) {
        std::string out;
        for (;;) {
            if (!fill()) throw TransportError("connection closed while reading headers");
            char* start = buf_ + pos_;
            char* nl = static_cast<char*>(std::memchr(start, '\n', len_ - pos_));
            if (nl) {
                out.append(start, static_cast<std::size_t>(nl - start));
                pos_ += static_cast<std::size_t>(nl - start) + 1;
                if (!out.empty() && out.back() == '\r') out.pop_back();
                return out;
            }
            out.append(start, len_ - pos_);
            pos_ = len_;
            if (out.size() > max) throw TransportError("HTTP line too long");
        }
    }
    /// Delivers exactly n bytes to sink.
    void exact(std::uint64_t n, const Sink& sink) {
        while (n > 0) {
            if (!fill()) throw TransportError("connection closed before end of body");
            std::size_t take = static_cast<std::size_t>(std::min<std::uint64_t>(n, len_ - pos_));
            if (sink) sink(buf_ + pos_, take);
            pos_ += take;
            n -= take;
        }
    }
    /// Delivers everything until EOF.
    std::uint64_t until_eof(const Sink& sink) {
        std::uint64_t total = 0;
        while (fill()) {
            std::size_t take = len_ - pos_;
            if (sink) sink(buf_ + pos_, take);
            total += take;
            pos_ = len_;
        }
        return total;
    }

private:
    Reader& r_;
    char buf_[64 * 1024];
    std::size_t pos_ = 0, len_ = 0;
};

struct ResponseHead {
    int status = 0;
    std::string reason;
    Headers headers;
    std::string header(const std::string& k) const {
        auto it = headers.find(k);
        return it == headers.end() ? std::string() : it->second;
    }
};

inline ResponseHead read_head(BufReader& br) {
    for (;;) {
        ResponseHead h;
        std::string sl = br.line();
        // HTTP/1.1 200 OK
        if (sl.compare(0, 5, "HTTP/") != 0) throw TransportError("malformed status line: " + sl.substr(0, 80));
        auto sp = sl.find(' ');
        if (sp == std::string::npos || sl.size() < sp + 4) throw TransportError("malformed status line: " + sl.substr(0, 80));
        try {
            h.status = std::stoi(sl.substr(sp + 1, 3));
        } catch (...) {
            throw TransportError("malformed status code: " + sl.substr(0, 80));
        }
        if (sl.size() > sp + 5) h.reason = sl.substr(sp + 5);
        std::size_t count = 0;
        for (;;) {
            std::string l = br.line();
            if (l.empty()) break;
            if (++count > 256) throw TransportError("too many response headers");
            auto c = l.find(':');
            if (c == std::string::npos) throw TransportError("malformed header line");
            std::string k = lower(trim(l.substr(0, c)));
            std::string v = trim(l.substr(c + 1));
            auto it = h.headers.find(k);
            if (it != h.headers.end()) it->second += ", " + v;
            else h.headers.emplace(std::move(k), std::move(v));
        }
        if (h.status >= 100 && h.status < 200 && h.status != 101) continue;  // skip 100 Continue etc.
        return h;
    }
}

/// Reads the body according to framing rules; returns bytes delivered.
inline std::uint64_t read_body(BufReader& br, const ResponseHead& h, bool head_request, const Sink& sink) {
    if (head_request || h.status == 204 || h.status == 304) return 0;
    std::string te = lower(h.header("transfer-encoding"));
    if (!te.empty() && te.find("chunked") != std::string::npos) {
        std::uint64_t total = 0;
        for (;;) {
            std::string sz = br.line();
            auto semi = sz.find(';');
            if (semi != std::string::npos) sz = sz.substr(0, semi);
            sz = trim(sz);
            if (sz.empty() || sz.size() > 16) throw TransportError("malformed chunk size");
            std::uint64_t n = 0;
            for (char c : sz) {
                n <<= 4;
                if (c >= '0' && c <= '9') n |= static_cast<std::uint64_t>(c - '0');
                else if (c >= 'a' && c <= 'f') n |= static_cast<std::uint64_t>(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') n |= static_cast<std::uint64_t>(c - 'A' + 10);
                else throw TransportError("malformed chunk size");
            }
            if (n == 0) {
                while (!br.line().empty()) {
                }  // trailers
                return total;
            }
            br.exact(n, sink);
            total += n;
            if (!br.line().empty()) throw TransportError("missing CRLF after chunk");
        }
    }
    std::string cl = h.header("content-length");
    if (!cl.empty()) {
        std::uint64_t n = 0;
        try {
            n = std::stoull(cl);
        } catch (...) {
            throw TransportError("malformed Content-Length");
        }
        br.exact(n, sink);
        return n;
    }
    return br.until_eof(sink);
}

// ------------------------------------------------------------------ sockets

#ifdef _WIN32
using socket_t = SOCKET;
constexpr socket_t invalid_socket = INVALID_SOCKET;
inline int last_error() { return WSAGetLastError(); }
inline void close_socket(socket_t s) { closesocket(s); }
inline bool would_block(int e) { return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS; }
inline bool is_timeout_err(int e) { return e == WSAETIMEDOUT; }
struct WinsockInit {
    WinsockInit() {
        WSADATA d;
        if (WSAStartup(MAKEWORD(2, 2), &d) != 0) throw TransportError("WSAStartup failed");
    }
    ~WinsockInit() { WSACleanup(); }
};
inline void net_init() { static WinsockInit init; }
#else
using socket_t = int;
constexpr socket_t invalid_socket = -1;
inline int last_error() { return errno; }
inline void close_socket(socket_t s) { ::close(s); }
inline bool would_block(int e) { return e == EINPROGRESS || e == EWOULDBLOCK || e == EAGAIN; }
inline bool is_timeout_err(int e) { return e == EAGAIN || e == EWOULDBLOCK || e == ETIMEDOUT; }
inline void net_init() {}
#endif

inline std::string sys_error(int e) {
#ifdef _WIN32
    char buf[256] = {0};
    FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, static_cast<DWORD>(e), 0, buf,
                   sizeof buf, nullptr);
    std::string s(buf);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
    return s + " (" + std::to_string(e) + ")";
#else
    return std::string(std::strerror(e)) + " (" + std::to_string(e) + ")";
#endif
}

/// RAII TCP connection with per-operation timeouts.
class Socket : public Reader {
public:
    Socket(const std::string& host, int port, int timeout_ms) : timeout_ms_(timeout_ms) {
        net_init();
        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        addrinfo* res = nullptr;
        std::string ps = std::to_string(port);
        int rc = getaddrinfo(host.c_str(), ps.c_str(), &hints, &res);
        if (rc != 0 || !res) throw TransportError("cannot resolve " + host);
        std::string err = "connect failed";
        bool timed_out = false;
        for (addrinfo* ai = res; ai; ai = ai->ai_next) {
            socket_t s = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
            if (s == invalid_socket) continue;
            if (connect_with_timeout(s, ai->ai_addr, static_cast<int>(ai->ai_addrlen), err, timed_out)) {
                s_ = s;
                break;
            }
            close_socket(s);
        }
        freeaddrinfo(res);
        if (s_ == invalid_socket) throw TransportError(host + ":" + ps + ": " + err, timed_out);
        set_timeouts();
        int one = 1;
        setsockopt(s_, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof one);
#ifdef SO_NOSIGPIPE
        setsockopt(s_, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
    }
    ~Socket() override {
        if (s_ != invalid_socket) close_socket(s_);
    }
    Socket(const Socket&) = delete;
    Socket& operator=(const Socket&) = delete;

    void send_all(const char* p, std::size_t n) {
        while (n > 0) {
            int chunk = static_cast<int>(std::min<std::size_t>(n, 1 << 20));
#if defined(MSG_NOSIGNAL)
            int w = static_cast<int>(::send(s_, p, chunk, MSG_NOSIGNAL));
#else
            int w = static_cast<int>(::send(s_, p, chunk, 0));
#endif
            if (w <= 0) {
                int e = last_error();
                if (is_timeout_err(e)) throw TransportError("send timed out", true);
                throw TransportError("send failed: " + sys_error(e));
            }
            p += w;
            n -= static_cast<std::size_t>(w);
        }
    }
    void send_all(const std::string& s) { send_all(s.data(), s.size()); }

    std::size_t read_some(char* buf, std::size_t cap) override {
        for (;;) {
            int r = static_cast<int>(::recv(s_, buf, static_cast<int>(std::min<std::size_t>(cap, 1 << 20)), 0));
            if (r >= 0) return static_cast<std::size_t>(r);
            int e = last_error();
#ifndef _WIN32
            if (e == EINTR) continue;
#endif
            if (is_timeout_err(e)) throw TransportError("read timed out after " + std::to_string(timeout_ms_) + " ms", true);
            throw TransportError("recv failed: " + sys_error(e));
        }
    }

private:
    socket_t s_ = invalid_socket;
    int timeout_ms_;

    void set_timeouts() {
#ifdef _WIN32
        DWORD t = static_cast<DWORD>(timeout_ms_);
        setsockopt(s_, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&t), sizeof t);
        setsockopt(s_, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&t), sizeof t);
#else
        timeval tv{};
        tv.tv_sec = timeout_ms_ / 1000;
        tv.tv_usec = (timeout_ms_ % 1000) * 1000;
        setsockopt(s_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        setsockopt(s_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
    }

    bool connect_with_timeout(socket_t s, const sockaddr* addr, int len, std::string& err, bool& timed_out) {
#ifdef _WIN32
        u_long nb = 1;
        ioctlsocket(s, FIONBIO, &nb);
#else
        int flags = fcntl(s, F_GETFL, 0);
        fcntl(s, F_SETFL, flags | O_NONBLOCK);
#endif
        int rc = ::connect(s, addr, len);
        if (rc != 0) {
            int e = last_error();
            if (!would_block(e)) {
                err = "connect failed: " + sys_error(e);
                return false;
            }
#ifdef _WIN32
            fd_set wfds, efds;
            FD_ZERO(&wfds);
            FD_ZERO(&efds);
            FD_SET(s, &wfds);
            FD_SET(s, &efds);
            timeval tv{};
            tv.tv_sec = timeout_ms_ / 1000;
            tv.tv_usec = (timeout_ms_ % 1000) * 1000;
            int sel = ::select(0, nullptr, &wfds, &efds, &tv);
#else
            pollfd pfd{s, POLLOUT, 0};
            int sel;
            do {
                sel = ::poll(&pfd, 1, timeout_ms_);
            } while (sel < 0 && errno == EINTR);
#endif
            if (sel == 0) {
                err = "connect timed out after " + std::to_string(timeout_ms_) + " ms";
                timed_out = true;
                return false;
            }
            if (sel < 0) {
                err = "connect failed: " + sys_error(last_error());
                return false;
            }
            int soerr = 0;
#ifdef _WIN32
            int sl = sizeof soerr;
#else
            socklen_t sl = sizeof soerr;
#endif
            getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&soerr), &sl);
            if (soerr != 0) {
                err = "connect failed: " + sys_error(soerr);
                return false;
            }
        }
#ifdef _WIN32
        nb = 0;
        ioctlsocket(s, FIONBIO, &nb);
#else
        fcntl(s, F_SETFL, flags);
#endif
        return true;
    }
};

struct Url {
    std::string host;
    int port = 80;
    std::string prefix;  // path prefix without trailing slash
};

inline Url parse_url(const std::string& u) {
    Url out;
    std::string rest;
    if (u.compare(0, 7, "http://") == 0) {
        rest = u.substr(7);
    } else if (u.compare(0, 8, "https://") == 0) {
        throw ArgumentError("https is not supported by the C++ client; use a TLS-terminating proxy (see README)");
    } else {
        throw ArgumentError("base_url must start with http://");
    }
    auto slash = rest.find('/');
    std::string hostport = rest.substr(0, slash);
    if (slash != std::string::npos) out.prefix = rest.substr(slash);
    while (!out.prefix.empty() && out.prefix.back() == '/') out.prefix.pop_back();
    if (!hostport.empty() && hostport[0] == '[') {  // [ipv6]:port
        auto rb = hostport.find(']');
        if (rb == std::string::npos) throw ArgumentError("bad IPv6 host");
        out.host = hostport.substr(1, rb - 1);
        if (rb + 1 < hostport.size() && hostport[rb + 1] == ':') out.port = std::stoi(hostport.substr(rb + 2));
    } else {
        auto colon = hostport.rfind(':');
        out.host = hostport.substr(0, colon);
        if (colon != std::string::npos) {
            try {
                out.port = std::stoi(hostport.substr(colon + 1));
            } catch (...) {
                throw ArgumentError("bad port in base_url");
            }
        }
    }
    if (out.host.empty()) throw ArgumentError("missing host in base_url");
    if (out.port <= 0 || out.port > 65535) throw ArgumentError("bad port in base_url");
    return out;
}

/// Request body descriptor.
struct Body {
    enum class Kind { None, Buffer, Stream } kind = Kind::None;
    const std::string* buffer = nullptr;
    Source source;
    std::optional<std::uint64_t> length;  // for Stream: known length -> Content-Length, else chunked
};

struct Response {
    ResponseHead head;
    std::uint64_t body_len = 0;
};

inline std::string status_phrase(int s) {
    switch (s) {
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 413: return "Payload Too Large";
        case 416: return "Range Not Satisfiable";
        case 500: return "Internal Server Error";
        case 502: return "Bad Gateway";
        case 503: return "Service Unavailable";
        case 504: return "Gateway Timeout";
        case 507: return "Insufficient Storage";
        default: return "HTTP error";
    }
}

inline ApiError make_api_error(int status, const std::string& body, const Headers& h, const std::string& reason) {
    std::string msg;
    try {
        msg = json::Value::parse(body)["error"].as_string();
    } catch (...) {
    }
    if (msg.empty()) msg = body.substr(0, 300);
    if (msg.empty()) msg = reason.empty() ? status_phrase(status) : reason;
    return ApiError(status, msg, body, h);
}

}  // namespace detail

// =====================================================================================  Client

/// Client for one reactor. Not thread-safe per instance only in the sense of mutable options; each
/// request opens its own connection, so concurrent calls on one instance are fine.
class Client {
public:
    /// @param base_url  e.g. "http://127.0.0.1:3005"
    /// @param token     x-reactor-token ("" when the reactor has no token)
    /// @param timeout_ms connect timeout and per send/recv timeout
    explicit Client(const std::string& base_url, std::string token = "", int timeout_ms = 60000)
        : url_(detail::parse_url(base_url)), token_(std::move(token)), timeout_ms_(timeout_ms) {}

    /// Retries for idempotent requests (GET/HEAD) on transport errors and 429/502/503/504. Default 3.
    void set_max_retries(int n) { max_retries_ = std::max(0, n); }
    /// Base backoff; attempt n waits backoff*2^(n-1) (+ jitter, capped at 10 s). Default 200 ms.
    void set_backoff_ms(int ms) { backoff_ms_ = std::max(0, ms); }
    void set_timeout_ms(int ms) { timeout_ms_ = ms; }

    // -------------------------------------------------------------- system / data plane

    /// GET /health (no auth).
    json::Value health() { return get_json("/health"); }

    /// POST /compress (buffered).
    CompressResult compress(const std::string& data, const UploadOptions& opts = {}) {
        CompressResult r;
        auto resp = call("POST", "/compress", buffer(data), hints(opts), string_sink(r.data));
        r.meta = meta_from(resp.head.headers);
        return r;
    }

    /// POST /compress streaming `in` (chunked upload) into `out`.
    CompressMeta compress_stream(std::istream& in, std::ostream& out, const UploadOptions& opts = {}) {
        auto resp = call("POST", "/compress", stream(in, std::nullopt), hints(opts), ostream_sink(out));
        return meta_from(resp.head.headers);
    }

    /// POST /decompress (buffered).
    std::string decompress(const std::string& blob) {
        std::string out;
        call("POST", "/decompress", buffer(blob), {}, string_sink(out));
        return out;
    }

    /// POST /decompress streaming `in` (chunked upload) into `out`; returns bytes written.
    std::uint64_t decompress_stream(std::istream& in, std::ostream& out) {
        return call("POST", "/decompress", stream(in, std::nullopt), {}, ostream_sink(out)).body_len;
    }

    /// POST /entropy.
    Entropy entropy(const std::string& data) {
        std::string body;
        call("POST", "/entropy", buffer(data), {}, string_sink(body));
        auto j = parse_json(body);
        return Entropy{j["size_bytes"].as_u64(), j["entropy_bits"].as_number(), j["suggested_routing"].as_string()};
    }

    /// GET /evolution/status.
    json::Value evolution_status() { return get_json("/evolution/status"); }

    // -------------------------------------------------------------- store

    /// PUT /store/files from memory. Never retried (each successful PUT adds a pin).
    PutResult store_put(const std::string& data, const UploadOptions& opts = {}) {
        return put_result(call_json("PUT", "/store/files", buffer(data), hints(opts)));
    }

    /// PUT /store/files streaming from `in`: Content-Length when `length` is given, else chunked.
    PutResult store_put_stream(std::istream& in, const UploadOptions& opts = {},
                               std::optional<std::uint64_t> length = std::nullopt) {
        return put_result(call_json("PUT", "/store/files", stream(in, length), hints(opts)));
    }

    /// PUT /store/files with a custom source callback (chunked unless `length` is given).
    PutResult store_put_source(Source src, const UploadOptions& opts = {},
                               std::optional<std::uint64_t> length = std::nullopt) {
        detail::Body b;
        b.kind = detail::Body::Kind::Stream;
        b.source = std::move(src);
        b.length = length;
        return put_result(call_json("PUT", "/store/files", b, hints(opts)));
    }

    /// PUT /store/files streaming a file from disk with its known length.
    PutResult store_put_file(const std::string& path, const UploadOptions& opts = {}) {
        std::ifstream f(path, std::ios::binary | std::ios::ate);
        if (!f) throw ArgumentError("cannot open " + path);
        auto size = static_cast<std::uint64_t>(f.tellg());
        f.seekg(0);
        return store_put_stream(f, opts, size);
    }

    /// GET /store/files/{id} into memory (206 with a range).
    GetResult store_get(const std::string& file_id, std::optional<ByteRange> range = std::nullopt) {
        GetResult r;
        r.info = store_get_to(file_id, string_sink(r.data), range, [&r] { r.data.clear(); });
        return r;
    }

    /// Streams a file (or range) into `out`.
    RangeInfo store_get_to(const std::string& file_id, std::ostream& out, std::optional<ByteRange> range = std::nullopt) {
        return store_get_to(file_id, ostream_sink(out), range);
    }

    /// Streams a file (or range) into a sink callback. `reset` is invoked before a retry if needed.
    RangeInfo store_get_to(const std::string& file_id, const Sink& sink, std::optional<ByteRange> range = std::nullopt,
                           const std::function<void()>& reset = {}) {
        std::vector<std::pair<std::string, std::string>> h;
        if (range) h.emplace_back("Range", range->header_value());
        auto resp = call("GET", file_path(file_id), {}, h, sink, reset);
        RangeInfo info;
        info.status = resp.head.status;
        info.length = resp.body_len;
        info.etag = resp.head.header("etag");
        info.headers = resp.head.headers;
        std::string cr = resp.head.header("content-range");
        std::uint64_t s = 0, e = 0;
        std::optional<std::uint64_t> total;
        if (resp.head.status == 206 && !cr.empty()) {
            if (!detail::parse_content_range(cr, s, e, total)) throw TransportError("bad Content-Range: " + cr);
            info.start = s;
            info.end = e;
            info.total = total;
        } else {
            info.start = 0;
            if (resp.body_len > 0) info.end = resp.body_len - 1;
            info.total = resp.body_len;
        }
        return info;
    }

    /// HEAD /store/files/{id}.
    HeadResult store_head(const std::string& file_id) {
        auto resp = call("HEAD", file_path(file_id), {}, {}, {});
        HeadResult r;
        std::string cl = resp.head.header("content-length");
        if (!cl.empty()) r.size = std::stoull(cl);
        r.accept_ranges = resp.head.header("accept-ranges");
        r.etag = resp.head.header("etag");
        return r;
    }

    bool store_exists(const std::string& file_id) {
        try {
            store_head(file_id);
            return true;
        } catch (const ApiError& e) {
            if (e.kind() == ErrorKind::NotFound) return false;
            throw;
        }
    }

    /// DELETE /store/files/{id} (unpin once; never retried). ApiError NotFound once no longer stored.
    DeleteResult store_delete(const std::string& file_id) {
        return typed("DELETE /store/files", call_json("DELETE", file_path(file_id), {}, {}), parse_delete_result);
    }

    /// GET /store/stats (ApiError 503 / ErrorKind::Server when the object store is disabled).
    StoreStats store_stats() { return typed("GET /store/stats", get_json("/store/stats"), parse_store_stats); }

    /// GET /cluster/status: node config, per-peer health, sampled holders, top demand and data-gravity
    /// metrics. ApiError 503 (ErrorKind::Server) when data gravity is disabled (no store or no
    /// REACTOR_CLUSTER_TOKEN).
    ClusterStatus cluster_status() {
        return typed("GET /cluster/status", get_json("/cluster/status"), parse_cluster_status);
    }

private:
    using HeaderList = std::vector<std::pair<std::string, std::string>>;

    detail::Url url_;
    std::string token_;
    int timeout_ms_;
    int max_retries_ = 3;
    int backoff_ms_ = 200;

    static detail::Body buffer(const std::string& s) {
        detail::Body b;
        b.kind = detail::Body::Kind::Buffer;
        b.buffer = &s;
        return b;
    }
    static detail::Body stream(std::istream& in, std::optional<std::uint64_t> length) {
        detail::Body b;
        b.kind = detail::Body::Kind::Stream;
        b.length = length;
        b.source = [&in](char* buf, std::size_t cap) -> std::size_t {
            if (!in) return 0;
            in.read(buf, static_cast<std::streamsize>(cap));
            return static_cast<std::size_t>(in.gcount());
        };
        return b;
    }
    static Sink string_sink(std::string& s) {
        return [&s](const char* p, std::size_t n) { s.append(p, n); };
    }
    static Sink ostream_sink(std::ostream& o) {
        return [&o](const char* p, std::size_t n) {
            o.write(p, static_cast<std::streamsize>(n));
            if (!o) throw Error("failed writing to output stream");
        };
    }
    static HeaderList hints(const UploadOptions& o) {
        HeaderList h;
        if (!o.content_type.empty()) h.emplace_back("x-content-type", o.content_type);
        if (o.no_sample) h.emplace_back("x-reactor-no-sample", "1");
        return h;
    }
    static std::string file_path(const std::string& id) {
        if (id.empty()) throw ArgumentError("empty file id");
        for (char c : id)
            if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_')
                throw ArgumentError("invalid file id");
        return "/store/files/" + id;
    }
    static json::Value parse_json(const std::string& body) {
        if (body.empty()) return json::Value(json::Value::Object{});
        try {
            return json::Value::parse(body);
        } catch (const std::exception& e) {
            throw TransportError(std::string("invalid JSON response: ") + e.what());
        }
    }
    template <class F>
    static auto typed(const char* what, const json::Value& j, F parse) -> decltype(parse(j)) {
        try {
            return parse(j);
        } catch (const std::runtime_error& e) {
            throw TransportError(std::string(what) + ": invalid response: " + e.what());
        }
    }
    static PutResult put_result(const json::Value& j) { return typed("PUT /store/files", j, parse_put_result); }
    static CompressMeta meta_from(const Headers& h) {
        auto get = [&h](const char* k) {
            auto it = h.find(k);
            return it == h.end() ? std::string() : it->second;
        };
        auto num = [&](const char* k) {
            std::string v = get(k);
            return v.empty() ? 0.0 : std::strtod(v.c_str(), nullptr);
        };
        CompressMeta m;
        m.content_class = get("x-reactor-class");
        try {
            std::string r = get("x-reactor-recipe");
            if (!r.empty()) m.recipe = json::Value::parse(r);
        } catch (...) {
        }
        m.format = get("x-reactor-format");
        m.original_size = static_cast<std::uint64_t>(num("x-original-size"));
        m.compressed_size = static_cast<std::uint64_t>(num("x-compressed-size"));
        m.algo = get("x-datran-algo");
        m.ratio = num("x-datran-ratio");  // "3.68x" -> strtod stops at 'x'
        m.time_us = static_cast<std::uint64_t>(num("x-datran-time-us"));
        m.entropy = num("x-datran-entropy");
        m.note = get("x-reactor-note");
        m.headers = h;
        return m;
    }

    json::Value get_json(const std::string& path) {
        std::string body;
        call("GET", path, {}, {}, string_sink(body), [&body] { body.clear(); });
        return parse_json(body);
    }
    json::Value call_json(const char* method, const std::string& path, const detail::Body& b, const HeaderList& h) {
        std::string body;
        call(method, path, b, h, string_sink(body));
        return parse_json(body);
    }

    /// One attempt. Non-2xx bodies are captured (not passed to sink) and thrown as ApiError.
    detail::Response once(const std::string& method, const std::string& path, const detail::Body& body,
                          const HeaderList& extra, const Sink& sink) {
        detail::Socket sock(url_.host, url_.port, timeout_ms_);
        std::string req;
        req.reserve(512);
        req += method + " " + url_.prefix + path + " HTTP/1.1\r\n";
        req += "Host: " + url_.host + (url_.port == 80 ? "" : ":" + std::to_string(url_.port)) + "\r\n";
        req += "User-Agent: datran-client-cpp/0.1.0\r\nAccept-Encoding: identity\r\nConnection: close\r\n";
        if (!token_.empty()) req += "x-reactor-token: " + token_ + "\r\n";
        for (auto& kv : extra) {
            if (kv.first.find_first_of("\r\n:") != std::string::npos || kv.second.find_first_of("\r\n") != std::string::npos)
                throw ArgumentError("invalid header");
            req += kv.first + ": " + kv.second + "\r\n";
        }
        bool chunked = false;
        if (body.kind == detail::Body::Kind::Buffer) {
            req += "Content-Type: application/octet-stream\r\nContent-Length: " + std::to_string(body.buffer->size()) + "\r\n";
        } else if (body.kind == detail::Body::Kind::Stream) {
            req += "Content-Type: application/octet-stream\r\n";
            if (body.length) req += "Content-Length: " + std::to_string(*body.length) + "\r\n";
            else {
                req += "Transfer-Encoding: chunked\r\n";
                chunked = true;
            }
        } else if (method == "POST" || method == "PUT") {
            req += "Content-Length: 0\r\n";
        }
        req += "\r\n";
        if (body.kind == detail::Body::Kind::Buffer && body.buffer->size() <= 64 * 1024) {
            req += *body.buffer;  // single write for small bodies
            sock.send_all(req);
        } else {
            sock.send_all(req);
            if (body.kind == detail::Body::Kind::Buffer) {
                sock.send_all(*body.buffer);
            } else if (body.kind == detail::Body::Kind::Stream) {
                std::vector<char> buf(64 * 1024 + 16);
                std::uint64_t sent = 0;
                for (;;) {
                    std::size_t n = body.source(buf.data() + 10, 64 * 1024);
                    if (n == 0) break;
                    if (chunked) {
                        char hdr[12];
                        int hl = std::snprintf(hdr, sizeof hdr, "%zx\r\n", n);
                        sock.send_all(hdr, static_cast<std::size_t>(hl));
                        sock.send_all(buf.data() + 10, n);
                        sock.send_all("\r\n", 2);
                    } else {
                        if (sent + n > *body.length) throw ArgumentError("request body longer than declared length");
                        sock.send_all(buf.data() + 10, n);
                    }
                    sent += n;
                }
                if (chunked) sock.send_all("0\r\n\r\n", 5);
                else if (sent != *body.length) throw ArgumentError("request body shorter than declared length");
            }
        }
        detail::BufReader br(sock);
        detail::Response resp;
        resp.head = detail::read_head(br);
        bool head_req = method == "HEAD";
        if (resp.head.status >= 200 && resp.head.status < 300) {
            resp.body_len = detail::read_body(br, resp.head, head_req, sink);
            return resp;
        }
        std::string err_body;
        try {
            detail::read_body(br, resp.head, head_req, [&err_body](const char* p, std::size_t n) {
                if (err_body.size() < 1 << 20) err_body.append(p, std::min<std::size_t>(n, (1 << 20) - err_body.size()));
            });
        } catch (const TransportError&) {
        }
        throw detail::make_api_error(resp.head.status, err_body, resp.head.headers, resp.head.reason);
    }

    detail::Response call(const std::string& method, const std::string& path, const detail::Body& body,
                          const HeaderList& extra, const Sink& sink, const std::function<void()>& reset = {}) {
        bool idempotent = (method == "GET" || method == "HEAD") && body.kind == detail::Body::Kind::None;
        int attempts = idempotent ? max_retries_ + 1 : 1;
        for (int attempt = 0;; ++attempt) {
            if (attempt > 0) {
                long long d = std::min<long long>(10000, static_cast<long long>(backoff_ms_) << std::min(attempt - 1, 16));
                static thread_local std::mt19937 rng{std::random_device{}()};
                long long j = d > 0 ? std::uniform_int_distribution<long long>(0, d / 2)(rng) : 0;
                std::this_thread::sleep_for(std::chrono::milliseconds(d + j));
            }
            bool delivered = false;
            Sink tracking = sink ? Sink([&](const char* p, std::size_t n) {
                delivered = true;
                sink(p, n);
            })
                                 : Sink();
            bool last = attempt + 1 >= attempts;
            try {
                return once(method, path, body, extra, tracking);
            } catch (const ApiError& e) {
                int s = e.status();
                if (last || !(s == 429 || s == 502 || s == 503 || s == 504)) throw;
            } catch (const TransportError&) {
                // Retrying after partial delivery is only safe when the caller can reset the sink.
                if (last || (delivered && !reset)) throw;
                if (delivered) reset();
            }
        }
    }
};

}  // namespace datran
