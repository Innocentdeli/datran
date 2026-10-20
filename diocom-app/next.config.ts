import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Compression is done by the reverse proxy (deploy/caddy), which skips already-compressed
  // downloads and Range responses; Next's own gzip would pre-empt those rules.
  compress: false,
  // Redis client for shared multi-instance state (src/lib/kv); kept as a runtime dependency, not bundled.
  // pino/prom-client (src/lib/observability) are Node-only and keep process-wide state: not bundled either.
  serverExternalPackages: ["ioredis", "pino", "pino-pretty", "prom-client"],
  poweredByHeader: false,
  // Baseline security headers from the app itself, so they are present without the Caddy edge too (direct
  // deployments, Docker healthcheck port, tests). Same values as deploy/caddy/app.caddy, which overwrites them.
  // frame-ancestors 'self': the PDF viewer frames same-origin /api/stream URLs.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
