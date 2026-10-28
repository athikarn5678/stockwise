import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { NextConfig } from "next";

import { getApiHealthRewrite, getApiV1Rewrite } from "./src/api-proxy";
import { loadWebEnvironment } from "./src/environment";

const localEnvironmentFile = resolve(import.meta.dirname, "../../.env");

if (existsSync(localEnvironmentFile)) {
  process.loadEnvFile(localEnvironmentFile);
}

const environment = loadWebEnvironment();

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        // Any document can host verification after an App Router navigation.
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          // POS barcode scanning needs the camera on this origin only.
          { key: "Permissions-Policy", value: "camera=(self)" },
        ],
      },
      {
        // The verification link token must never be cached or forwarded to
        // third parties. ADR-034 secure-link handling.
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
        source: "/verify-email",
      },
      {
        source: "/reset-password",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/accept-invitation",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  async rewrites() {
    return [getApiHealthRewrite(environment), getApiV1Rewrite(environment)];
  },
};

export default nextConfig;
