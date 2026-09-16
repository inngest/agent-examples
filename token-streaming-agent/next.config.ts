import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with its own minimal server.js so the app can run
  // in a slim Docker image without node_modules (see Dockerfile.web / Render).
  output: "standalone",
};

export default nextConfig;
