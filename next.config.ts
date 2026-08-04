import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 16.3 generates AGENTS.md/CLAUDE.md on dev by default; opt out.
  agentRules: false,
};

export default nextConfig;
