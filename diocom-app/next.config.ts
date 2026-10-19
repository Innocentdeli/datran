import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Compression is done by the reverse proxy (deploy/caddy), which skips already-compressed
  // downloads and Range responses; Next's own gzip would pre-empt those rules.
  compress: false,
  // Redis client for shared multi-instance state (src/lib/kv); kept as a runtime dependency, not bundled.
  // pino/prom-client (src/lib/observability) are Node-only and keep process-wide state: not bundled either.
  serverExternalPackages: ["ioredis", "pino", "pino-pretty", "prom-client"],
};

export default nextConfig;
