import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // Hide the on-screen dev indicator (route/static context button) in development.
  devIndicators: false,
  // Use the TypeScript compiler API. Next's CLI capture path returns empty
  // stdout under this Node 22 environment even though `tsc --showConfig` is valid.
  experimental: { useTypeScriptCli: false }
};

export default nextConfig;

