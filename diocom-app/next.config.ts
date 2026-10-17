import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Compression is done by the reverse proxy (deploy/caddy), which skips already-compressed
  // downloads and Range responses; Next's own gzip would pre-empt those rules.
  compress: false,
};

export default nextConfig;
