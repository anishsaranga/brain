import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No basePath. `brain` is served on its own subdomain
  // (<HOSTNAME>), unlike `learn` which lives at a path and pays for
  // it in middleware/Auth.js basePath workarounds. Keeping the app at the
  // origin root also leaves /.well-known/* free for the OAuth protected-resource
  // metadata that stage-2 connector auth will need.
  output: "standalone",
  turbopack: {},

  // Both ship native addons and must be require()'d from node_modules at
  // runtime rather than bundled — bundling breaks the addon loader.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],

  // NOTE: onnxruntime-node is deliberately NOT handled here. The tracer cannot
  // follow the runtime `require` that transformers.js uses to reach it, and
  // naming files individually missed its transitive dependencies. The
  // Dockerfile copies that package and onnxruntime-common wholesale into the
  // runner instead, then prunes the platform binaries. See the comment there.

  // Baseline security headers, same set as the other services on this box.
  // Served over HTTPS via the Cloudflare Tunnel.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
