// Tests for datran/client.hpp: offline parser tests + live tests against a reactor.
// Live reactor: REACTOR_URL (+REACTOR_TOKEN), or REACTOR_BIN started on an ephemeral port with a temp
// state dir (fallback: ../../core-reactor/target/release/core-reactor[.exe] relative to the source dir).
#include <datran/client.hpp>

#ifndef DATRAN_SOURCE_DIR
#define DATRAN_SOURCE_DIR "."  // CMake passes the clients/cpp source dir
#endif

#include <array>
#include <filesystem>
#include <iostream>
#include <sstream>

#ifdef _WIN32
#include <windows.h>
#else
#include <csignal>
#include <sys/wait.h>
#endif

namespace fs = std::filesystem;
using namespace datran;

// ------------------------------------------------------------------ mini test framework

static int g_pass = 0, g_fail = 0, g_skip = 0;

struct SkipTest {
    std::string why;
};

#define CHECK(cond)                                                                                     \
    do {                                                                                                \
        if (!(cond)) throw std::runtime_error(std::string("CHECK failed: ") + #cond + " (line " +       \
                                              std::to_string(__LINE__) + ")");                          \
    } while (0)

#define CHECK_THROWS_AS(expr, Type)                                                                     \
    do {                                                                                                \
        bool thrown_ = false;                                                                           \
        try {                                                                                           \
            (void)(expr);                                                                               \
        } catch (const Type&) {                                                                         \
            thrown_ = true;                                                                             \
        }                                                                                               \
        if (!thrown_) throw std::runtime_error(std::string("expected ") + #Type + " from " + #expr +    \
                                               " (line " + std::to_string(__LINE__) + ")");             \
    } while (0)

template <class F>
static void run(const char* name, F f) {
    try {
        f();
        ++g_pass;
        std::cout << "ok      " << name << "\n";
    } catch (const SkipTest& s) {
        ++g_skip;
        std::cout << "SKIPPED " << name << ": " << s.why << "\n";
    } catch (const std::exception& e) {
        ++g_fail;
        std::cout << "FAILED  " << name << ": " << e.what() << "\n";
    }
}

/// Cluster metrics object with values 1..23 in declaration order (unpins_forwarded = 23).
static json::Value metrics_fixture() {
    static const char* keys[] = {"gossip_rounds", "pulls", "pull_bytes", "pull_failures", "drops", "origin_transfers",
                                 "repairs", "remote_reads", "remote_read_bytes", "remote_objects_fetched",
                                 "remote_fetch_bytes", "remote_fetch_failures", "cache_hits", "cache_bytes",
                                 "cache_objects", "tombstones_applied", "quarantine_repairs",
                                 "quarantine_repair_failures", "leases_granted", "leases_refused", "leases_active",
                                 "evictions_confirmed", "unpins_forwarded"};
    json::Value::Object o;
    double i = 1;
    for (auto* k : keys) o[k] = json::Value(i++);
    return json::Value(o);
}

template <class F>
static int expect_status(F f) {
    try {
        f();
    } catch (const ApiError& e) {
        return e.status();
    }
    return 0;
}

// ------------------------------------------------------------------ SHA-256 (test only)

static std::string sha256_hex(const std::string& msg) {
    static const uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2};
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    std::string m = msg;
    uint64_t bits = static_cast<uint64_t>(msg.size()) * 8;
    m += static_cast<char>(0x80);
    while (m.size() % 64 != 56) m += '\0';
    for (int i = 7; i >= 0; --i) m += static_cast<char>((bits >> (i * 8)) & 0xff);
    auto rotr = [](uint32_t x, int n) { return (x >> n) | (x << (32 - n)); };
    for (size_t off = 0; off < m.size(); off += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; ++i)
            w[i] = (uint32_t(uint8_t(m[off + i * 4])) << 24) | (uint32_t(uint8_t(m[off + i * 4 + 1])) << 16) |
                   (uint32_t(uint8_t(m[off + i * 4 + 2])) << 8) | uint32_t(uint8_t(m[off + i * 4 + 3]));
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = hh + S1 + ch + k[i] + w[i];
            uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = S0 + mj;
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    char out[65];
    for (int i = 0; i < 8; ++i) std::snprintf(out + i * 8, 9, "%08x", h[i]);
    return std::string(out, 64);
}

// ------------------------------------------------------------------ data helpers

static std::string sample_text(int lines) {
    std::string s;
    for (int i = 0; i < lines; ++i)
        s += "{\"id\":" + std::to_string(i) + ",\"name\":\"user" + std::to_string(i) + "\",\"ok\":" +
             (i % 3 == 0 ? "true" : "false") + "}\n";
    return s;
}

static std::string random_bytes(size_t n, uint64_t seed) {
    std::string out;
    out.reserve(n + 8);
    uint64_t x = seed | 1;
    while (out.size() < n) {
        x ^= x >> 12; x ^= x << 25; x ^= x >> 27;
        uint64_t v = x * 0x2545F4914F6CDD1DULL;
        for (int i = 0; i < 8; ++i) out += static_cast<char>((v >> (i * 8)) & 0xff);
    }
    out.resize(n);
    return out;
}

// ------------------------------------------------------------------ reactor process

struct Reactor {
    std::string url, token;
    fs::path dir;
#ifdef _WIN32
    PROCESS_INFORMATION pi{};
    bool spawned = false;
#else
    pid_t pid = -1;
#endif
    ~Reactor() {
#ifdef _WIN32
        if (spawned) {
            TerminateProcess(pi.hProcess, 0);
            WaitForSingleObject(pi.hProcess, 10000);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
#else
        if (pid > 0) {
            kill(pid, SIGTERM);
            int st = 0;
            waitpid(pid, &st, 0);
        }
#endif
        if (!dir.empty()) {
            std::error_code ec;
            fs::remove_all(dir, ec);
        }
    }
};

static int free_port() {
    detail::net_init();
    auto s = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    ::bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a);
#ifdef _WIN32
    int len = sizeof a;
#else
    socklen_t len = sizeof a;
#endif
    getsockname(s, reinterpret_cast<sockaddr*>(&a), &len);
    int port = ntohs(a.sin_port);
    detail::close_socket(s);
    return port;
}

static void set_env(const char* k, const std::string& v) {
#ifdef _WIN32
    _putenv_s(k, v.c_str());
#else
    setenv(k, v.c_str(), 1);
#endif
}

static std::string env(const char* k) {
    const char* v = std::getenv(k);
    return v ? v : "";
}

static std::unique_ptr<Reactor> start_reactor() {
    auto r = std::make_unique<Reactor>();
    if (!env("REACTOR_URL").empty()) {
        r->url = env("REACTOR_URL");
        while (!r->url.empty() && r->url.back() == '/') r->url.pop_back();
        r->token = env("REACTOR_TOKEN");
        return r;
    }
    std::string bin = env("REACTOR_BIN");
    if (bin.empty()) {
        for (const char* n : {"core-reactor.exe", "core-reactor"}) {
            fs::path p = fs::path(DATRAN_SOURCE_DIR) / ".." / ".." / "core-reactor" / "target" / "release" / n;
            if (fs::is_regular_file(p)) {
                bin = p.string();
                break;
            }
        }
    }
    if (bin.empty() || !fs::is_regular_file(bin)) return nullptr;
    int port = free_port();
    r->token = env("REACTOR_TOKEN").empty() ? "test-" + std::to_string(port) + "-" + std::to_string(std::rand())
                                            : env("REACTOR_TOKEN");
    r->dir = fs::temp_directory_path() / ("datran-cpp-" + std::to_string(port));
    fs::create_directories(r->dir);
    set_env("REACTOR_PORT", std::to_string(port));
    set_env("REACTOR_TOKEN", r->token);
    set_env("REACTOR_STATE_DIR", r->dir.string());
    set_env("REACTOR_BIND", "127.0.0.1");
    set_env("REACTOR_CLUSTER_TOKEN", "");
#ifdef _WIN32
    STARTUPINFOA si{};
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    HANDLE nul = CreateFileA("NUL", GENERIC_WRITE, FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    SetHandleInformation(nul, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    si.hStdOutput = nul;
    si.hStdError = nul;
    si.hStdInput = nullptr;
    std::string cmd = "\"" + bin + "\"";
    if (!CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &r->pi))
        throw std::runtime_error("CreateProcess failed for " + bin);
    CloseHandle(nul);
    r->spawned = true;
#else
    r->pid = fork();
    if (r->pid == 0) {
        freopen("/dev/null", "w", stdout);
        freopen("/dev/null", "w", stderr);
        execl(bin.c_str(), bin.c_str(), static_cast<char*>(nullptr));
        _exit(127);
    }
    if (r->pid < 0) throw std::runtime_error("fork failed");
#endif
    r->url = "http://127.0.0.1:" + std::to_string(port);
    Client probe(r->url, "", 1000);
    probe.set_max_retries(0);
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (std::chrono::steady_clock::now() < deadline) {
        try {
            probe.health();
            return r;
        } catch (const TransportError&) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
    throw std::runtime_error("reactor did not become healthy within 30 s");
}

// ------------------------------------------------------------------ offline tests

static detail::Response parse_canned(const std::string& raw, bool head, std::string& body) {
    detail::StringReader sr(raw, 5);
    detail::BufReader br(sr);
    detail::Response r;
    r.head = detail::read_head(br);
    r.body_len = detail::read_body(br, r.head, head, [&body](const char* p, size_t n) { body.append(p, n); });
    return r;
}

static void offline_tests() {
    run("json parse/dump", [] {
        auto v = json::Value::parse(R"({"a":[1,2.5,-3e2,true,null],"s":"x\"yé😀","o":{}})");
        CHECK(v["a"].size() == 5);
        CHECK(v["a"][1].as_number() == 2.5);
        CHECK(v["a"][2].as_number() == -300);
        CHECK(v["a"][3].as_bool());
        CHECK(v["a"][4].is_null());
        CHECK(v["s"].as_string() == "x\"y\xc3\xa9\xf0\x9f\x98\x80");
        CHECK(v["o"].is_object() && v["o"].size() == 0);
        CHECK(v["missing"]["deeper"].is_null());
        CHECK(json::Value::parse(v.dump()).dump() == v.dump());
        CHECK_THROWS_AS(json::Value::parse("{\"a\":}"), std::runtime_error);
        CHECK_THROWS_AS(json::Value::parse("[1,2] x"), std::runtime_error);
    });
    run("http content-length response", [] {
        std::string body;
        auto r = parse_canned("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Reactor-Class: text/plain\r\n\r\nhelloEXTRA", false, body);
        CHECK(r.head.status == 200);
        CHECK(body == "hello");
        CHECK(r.head.header("x-reactor-class") == "text/plain");
    });
    run("http chunked response with extensions and trailers", [] {
        std::string body;
        auto r = parse_canned(
            "HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\nContent-Range: bytes 10-20/100\r\n\r\n"
            "4;ext=1\r\nWiki\r\n6\r\npedia \r\nE\r\nin \r\n\r\nchunks.\r\n0\r\nX-Trailer: y\r\n\r\n",
            false, body);
        CHECK(r.head.status == 206);
        CHECK(body == "Wikipedia in \r\n\r\nchunks.");
        uint64_t s, e;
        std::optional<uint64_t> t;
        CHECK(detail::parse_content_range(r.head.header("content-range"), s, e, t));
        CHECK(s == 10 && e == 20 && t && *t == 100);
    });
    run("http 100-continue, HEAD, read-to-close", [] {
        std::string body;
        auto r = parse_canned("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 42\r\n\r\n", true, body);
        CHECK(r.head.status == 200 && body.empty() && r.head.header("content-length") == "42");
        body.clear();
        parse_canned("HTTP/1.0 200 OK\r\n\r\nuntil close", false, body);
        CHECK(body == "until close");
    });
    run("http malformed responses -> TransportError", [] {
        std::string b;
        CHECK_THROWS_AS(parse_canned("garbage\r\n\r\n", false, b), TransportError);
        CHECK_THROWS_AS(parse_canned("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort", false, b), TransportError);
        CHECK_THROWS_AS(parse_canned("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n", false, b), TransportError);
    });
    run("error mapping", [] {
        auto e = detail::make_api_error(400, R"({"error":"bad","unknown_dict":")" + std::string(64, '0') + "\"}", {}, "");
        CHECK(e.kind() == ErrorKind::BadRequest && e.server_message() == "bad");
        CHECK(e.unknown_dict() == std::string(64, '0'));
        auto r = detail::make_api_error(416, "", {{"content-range", "bytes */1234"}}, "");
        CHECK(r.kind() == ErrorKind::RangeNotSatisfiable && r.range_total() && *r.range_total() == 1234);
        CHECK(r.server_message() == "Range Not Satisfiable");
        CHECK(error_kind_for(507) == ErrorKind::InsufficientStorage);
        CHECK(error_kind_for(502) == ErrorKind::Server);
        auto full = detail::make_api_error(507, R"({"error":"store full","needed":10,"used":90,"max":95})", {}, "");
        CHECK(full.server_message() == "store full");
        CHECK(full.store_full() && full.store_full()->needed == 10 && full.store_full()->used == 90 &&
              full.store_full()->max == 95);
        CHECK(!detail::make_api_error(507, "", {}, "").store_full());
    });
    run("store models", [] {
        auto j = json::Value::parse(
            R"({"chunks":0,"compression_ratio":1.0,"dedup_ratio":1,"evictions":0,"files":0,"full_rejections":0,)"
            R"("fusion":{"access_rows":0,"bytes_saved":0,"candidates_evaluated":0,"coaccess_min":8.0,"enabled":true,)"
            R"("fusions":0,"last_run_ms":0,"reads_saved":0,"rejected":0,"unfusions":0},"gc":{"collected_bytes":0,)"
            R"("collected_objects":0,"grace_ms":600000,"queue_bytes":0,"queue_objects":0,"startup_orphans_removed":0,)"
            R"("startup_temp_files_removed":0},"inflight_bytes":0,"inventory_version":0,"live_physical_bytes":0,)"
            R"("logical_bytes":0,"max_bytes":null,"objects":0,"physical_bytes":0,"put_bytes":0,"puts":0,"read_bytes":0,)"
            R"("reads":0,"scrub":{"bytes_checked":0,"corrupt_found":0,"last_pass_ms":0,"last_step_ms":0,)"
            R"("objects_checked":0,"pass_progress_objects":0,"passes_completed":0,"quarantined":0},"super_chunks":0,)"
            R"("tombstones":0,"total_ratio":1.0,"unique_bytes":0})");
        auto s = parse_store_stats(j);
        CHECK(!s.max_bytes && s.gc.grace_ms == 600000 && s.fusion.enabled && s.fusion.coaccess_min == 8.0);
        CHECK(s.dedup_ratio == 1.0);
        CHECK_THROWS_AS(parse_store_stats(json::Value::parse(R"({"files":0})")), std::runtime_error);
        CHECK(!s.group_commit && !s.cluster && s.packs.is_null());
        auto obj = j.as_object();
        obj["group_commit"] = json::Value::parse(R"({"batches":3,"jobs":5,"max_batch":2,"window_ms":2.0})");
        obj["cluster"] = metrics_fixture();
        obj["packs"] = json::Value::parse(R"({"files":1,"future":[1,2]})");
        auto s2 = parse_store_stats(json::Value(obj));
        CHECK(s2.group_commit && s2.group_commit->jobs == 5 && s2.group_commit->window_ms == 2.0);
        CHECK(s2.cluster && s2.cluster->unpins_forwarded == 23 && s2.cluster->gossip_rounds == 1);
        CHECK(s2.packs["files"].as_u64() == 1);
        auto d = parse_delete_result(json::Value::parse(R"({"file_id":"ab","pins":0,"deleted":true})"));
        CHECK(d.file_id == "ab" && d.pins == 0 && d.deleted && !d.forwarded_to);
        auto df = parse_delete_result(json::Value::parse(R"({"file_id":"ab","pins":0,"deleted":true,"forwarded_to":"n1"})"));
        CHECK(df.forwarded_to && *df.forwarded_to == "n1");
        CHECK_THROWS_AS(parse_delete_result(json::Value::parse(R"({"file_id":"ab","pins":true,"deleted":true})")),
                        std::runtime_error);
        auto p = parse_put_result(json::Value::parse(
            R"({"file_id":"ab","size":3,"stored_bytes":1,"new_bytes":3,"new_chunks":1,"dedup_chunks":0,"chunks":1,)"
            R"("class":"text/plain","duplicate":false,"pins":1})"));
        CHECK(p.content_class == "text/plain" && !p.duplicate && p.pins == 1 && p.chunks == 1);
    });
    run("cluster status model", [] {
        std::string a(32, 'a'), b(32, 'b'), f(64, 'f');
        auto obj = json::Value::parse(
            R"({"node_id":")" + a + R"(","region":null,"tls":false,"cluster_size":2,"min_replicas":2,)"
            R"("min_replicas_effective":2,"gravity_pull":3.0,"demand_half_life_ms":3600000,"gossip_interval_ms":200,)"
            R"("capacity":null,"used":123,"peers":[)"
            R"({"url":"http://127.0.0.1:1","node_id":")" + b + R"(","region":"eu","healthy":true,"is_self":false,)"
            R"("last_ok_ms":1700000000000,"last_error":null,"last_error_ms":null,"consecutive_failures":0,)"
            R"("inventory_version":4,"files":1,"capacity":null,"used":99},)"
            R"({"url":"http://127.0.0.1:2","node_id":null,"region":null,"healthy":false,"is_self":false,)"
            R"("last_ok_ms":null,"last_error":"connection refused","last_error_ms":1700000000001,)"
            R"("consecutive_failures":3,"inventory_version":0,"files":0,"capacity":null,"used":0}],)"
            R"("holders_sample":[{"file_id":")" + f + R"(","holders":[")" + a + R"(",")" + b +
            R"("],"local":true,"demand":0.0}],"demand_top":[{"file_id":")" + f + R"(","score":1.5}]})")
                       .as_object();
        obj["metrics"] = metrics_fixture();
        auto s = parse_cluster_status(json::Value(obj));
        CHECK(s.node_id == a && !s.region && !s.tls && s.cluster_size == 2 && !s.capacity && s.used && *s.used == 123);
        CHECK(s.gravity_pull == 3.0 && s.gossip_interval_ms == 200 && s.peers.size() == 2);
        auto* p = s.peer(b);
        CHECK(p && p->healthy && !p->is_self && p->files == 1 && p->region && *p->region == "eu" && !p->last_error);
        CHECK(!s.peers[1].node_id && s.peers[1].last_error && *s.peers[1].last_error == "connection refused");
        CHECK(s.holders_sample.size() == 1 && s.holders_sample[0].holders.size() == 2 && s.holders_sample[0].local);
        CHECK(s.demand_top.size() == 1 && s.demand_top[0].score == 1.5);
        CHECK(s.metrics.gossip_rounds == 1 && s.metrics.unpins_forwarded == 23);
        auto m = metrics_fixture().as_object();
        m.erase("pulls");
        obj["metrics"] = json::Value(m);
        CHECK_THROWS_AS(parse_cluster_status(json::Value(obj)), std::runtime_error);
    });
    run("ranges and urls", [] {
        CHECK(ByteRange::span(0, 99).header_value() == "bytes=0-99");
        CHECK(ByteRange::from(10).header_value() == "bytes=10-");
        CHECK(ByteRange::suffix(5).header_value() == "bytes=-5");
        CHECK_THROWS_AS(ByteRange::span(5, 1).header_value(), ArgumentError);
        auto u = detail::parse_url("http://example.com:8080/base/");
        CHECK(u.host == "example.com" && u.port == 8080 && u.prefix == "/base");
        CHECK(detail::parse_url("http://[::1]:9/").host == "::1");
        CHECK_THROWS_AS(detail::parse_url("https://x"), ArgumentError);
    });
    run("connection refused -> TransportError", [] {
        Client c("http://127.0.0.1:9", "", 2000);
        c.set_max_retries(1);
        c.set_backoff_ms(1);
        CHECK_THROWS_AS(c.health(), TransportError);
    });
}

// ------------------------------------------------------------------ live tests

static void live_tests(Reactor* r) {
    auto need = [r] {
        if (!r) throw SkipTest{"no reactor: set REACTOR_BIN or REACTOR_URL"};
    };
    auto client = [r] { return Client(r->url, r->token, 30000); };

    run("health", [&] {
        need();
        auto h = client().health();
        CHECK(h["status"].as_string() == "online");
        CHECK(h["features"].size() > 0);
    });
    run("compress/decompress round trip", [&] {
        need();
        auto c = client();
        std::string data = sample_text(5000);
        auto out = c.compress(data, {"application/json", false});
        CHECK(out.meta.original_size == data.size());
        CHECK(out.meta.compressed_size == out.data.size());
        CHECK(out.data.size() < data.size());
        CHECK(out.meta.format == "v2");
        CHECK(out.meta.recipe["codec"].is_string());
        CHECK(!out.meta.content_class.empty());
        CHECK(out.meta.ratio > 1.0);
        CHECK(c.decompress(out.data) == data);
    });
    run("streaming compress/decompress (chunked upload)", [&] {
        need();
        auto c = client();
        std::string data = sample_text(20000);
        std::istringstream in(data);
        std::ostringstream blob;
        auto meta = c.compress_stream(in, blob, {"", true});
        CHECK(blob.str().size() == meta.compressed_size);
        std::istringstream bin(blob.str());
        std::ostringstream back;
        CHECK(c.decompress_stream(bin, back) == data.size());
        CHECK(back.str() == data);
    });
    run("empty and incompressible input", [&] {
        need();
        auto c = client();
        CHECK(c.decompress(c.compress("").data).empty());
        std::string rnd = random_bytes(50000, 7);
        auto out = c.compress(rnd);
        CHECK(out.meta.content_class == "media/compressed");
        CHECK(out.meta.recipe.is_null());
        CHECK(out.meta.format == "legacy-raw");
        CHECK(c.decompress(out.data) == rnd);
    });
    run("errors: bad blob 400, bad token 401", [&] {
        need();
        auto c = client();
        try {
            c.decompress("\x67garbage");
            CHECK(false);
        } catch (const ApiError& e) {
            CHECK(e.status() == 400 && e.kind() == ErrorKind::BadRequest);
            CHECK(e.server_message().find("flag") != std::string::npos);
        }
        if (!r->token.empty()) {
            Client bad(r->url, "wrong-token", 10000);
            CHECK(expect_status([&] { bad.entropy("x"); }) == 401);
            CHECK(bad.health()["status"].as_string() == "online");
        }
    });
    run("entropy", [&] {
        need();
        auto e = client().entropy("hello");
        CHECK(e.size_bytes == 5);
        CHECK(std::fabs(e.entropy_bits - 1.92) < 0.01);
        CHECK(e.suggested_routing == "symbit");
    });
    run("evolution status", [&] {
        need();
        auto c = client();
        c.compress(sample_text(100), {"application/json", false});
        auto s = c.evolution_status();
        CHECK(s["interval_ms"].as_u64() > 0);
        CHECK(s["classes"].is_array() && s["classes"].size() > 0);
        CHECK(s["weights"]["decode"].is_number());
    });

    bool store = false;
    std::string store_skip = "no reactor";
    if (r) {
        try {
            client().store_stats();
            store = true;
        } catch (const ApiError& e) {
            if (e.kind() != ErrorKind::NotFound && e.status() != 503) throw;
            store_skip = "store not available on this reactor (/store/stats -> " + std::to_string(e.status()) + ")";
        }
    }
    auto need_store = [&] {
        if (!store) throw SkipTest{store_skip};
    };

    run("store put/get/range/head/delete", [&] {
        need_store();
        auto c = client();
        std::string data = sample_text(30000) + random_bytes(100000, 42);
        std::string fid = sha256_hex(data);
        auto put = c.store_put(data, {"application/json", false});
        CHECK(put.file_id == fid);
        CHECK(put.size == data.size());
        CHECK(!put.duplicate && put.pins == 1 && put.chunks > 0);
        CHECK(put.new_chunks + put.dedup_chunks == put.chunks);
        CHECK(put.stored_bytes > 0 && !put.content_class.empty());
        CHECK(put.new_bytes > 0 && put.new_bytes <= put.size);
        std::string etag = "\"" + fid + "\"";
        auto full = c.store_get(fid);
        CHECK(full.info.status == 200 && full.data == data);
        CHECK(full.info.etag == etag);
        auto h = c.store_head(fid);
        CHECK(h.size == data.size() && h.accept_ranges == "bytes");
        CHECK(h.etag == etag);
        std::string upper = fid;
        for (auto& ch : upper) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
        CHECK(c.store_exists(upper));
        auto g = c.store_get(fid, ByteRange::span(1000, 1999));
        CHECK(g.info.status == 206 && g.data == data.substr(1000, 1000));
        CHECK(g.info.start == 1000 && g.info.end && *g.info.end == 1999 && g.info.total && *g.info.total == data.size());
        CHECK(c.store_get(fid, ByteRange::suffix(777)).data == data.substr(data.size() - 777));
        CHECK(c.store_get(fid, ByteRange::from(data.size() - 10)).data == data.substr(data.size() - 10));
        CHECK(expect_status([&] { c.store_get(fid, ByteRange::from(data.size() + 10)); }) == 416);
        std::ostringstream sink;
        auto info = c.store_get_to(fid, sink);
        CHECK(info.length == data.size() && sha256_hex(sink.str()) == fid);
        auto d = c.store_delete(fid);
        CHECK(d.file_id == fid && d.pins == 0 && d.deleted);
        CHECK(expect_status([&] { c.store_get(fid); }) == 404);
        CHECK(!c.store_exists(fid));
        CHECK(expect_status([&] { c.store_delete(fid); }) == 404);
    });
    run("store put file / chunked stream / dedup / pins / stats", [&] {
        need_store();
        auto c = client();
        // A per-run tag on every line keeps every chunk unique, so the first put stores all of it.
        std::string data = sample_text(8000);
        {
            std::string tag = "\"" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()) + "-user";
            std::string out;
            for (size_t pos = 0;;) {
                size_t hit = data.find("\"user", pos);
                out.append(data, pos, hit == std::string::npos ? std::string::npos : hit - pos);
                if (hit == std::string::npos) break;
                out += tag;
                pos = hit + 5;
            }
            data = std::move(out);
        }
        std::string fid = sha256_hex(data);
        fs::path p = fs::temp_directory_path() / "datran-cpp-upload.json";
        {
            std::ofstream f(p, std::ios::binary);
            f << data;
        }
        auto a = c.store_put_file(p.string());
        fs::remove(p);
        std::istringstream in(data);
        auto b = c.store_put_stream(in);  // unknown length -> chunked
        CHECK(a.file_id == fid && b.file_id == fid);
        CHECK(b.new_chunks == 0 && b.dedup_chunks > 0);
        CHECK(b.dedup_chunks == b.chunks && b.duplicate && a.pins == 1 && b.pins == 2);
        // new_bytes: plaintext of newly stored chunks; compression = new_bytes / stored_bytes
        CHECK(a.new_chunks == a.chunks && a.new_bytes == data.size());
        CHECK(a.new_bytes > a.stored_bytes);  // JSON lines compress
        CHECK(b.new_bytes == 0 && b.stored_bytes == 0);
        auto d1 = c.store_delete(fid);  // one pin left
        CHECK(d1.pins == 1 && !d1.deleted);
        CHECK(c.store_get(fid).data == data);
        auto d2 = c.store_delete(fid);
        CHECK(d2.pins == 0 && d2.deleted);
        CHECK(expect_status([&] { c.store_head(fid); }) == 404);

        auto before = c.store_stats();
        std::string small = sample_text(3000);
        auto sp = c.store_put(small);
        auto s = c.store_stats();
        CHECK(s.files >= 1 && s.puts > before.puts);
        CHECK(s.logical_bytes >= small.size() && s.unique_bytes > 0 && s.live_physical_bytes > 0 && s.chunks > 0);
        CHECK(!s.max_bytes && s.dedup_ratio >= 1.0 && s.total_ratio > 0.0);
        CHECK(s.gc.grace_ms > 0 && s.fusion.coaccess_min > 0.0);
        CHECK(s.group_commit && s.group_commit->jobs >= 1);
        CHECK(!s.cluster);  // single reactor without REACTOR_CLUSTER_TOKEN
        auto nc = client();
        nc.set_max_retries(0);
        CHECK(expect_status([&] { nc.cluster_status(); }) == 503);
        c.store_delete(sp.file_id);

        CHECK(expect_status([&] { c.store_get(std::string(64, '0')); }) == 404);
        CHECK(expect_status([&] { c.store_get(std::string(64, 'z')); }) == 400);
    });
}

int main() {
    offline_tests();
    std::unique_ptr<Reactor> r;
    try {
        r = start_reactor();
    } catch (const std::exception& e) {
        std::cout << "FAILED  start reactor: " << e.what() << "\n";
        return 1;
    }
    live_tests(r.get());
    std::cout << "\n" << g_pass << " passed, " << g_fail << " failed, " << g_skip << " skipped\n";
    return g_fail == 0 ? 0 : 1;
}
