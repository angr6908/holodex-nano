import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 16.3 generates AGENTS.md/CLAUDE.md on dev by default; opt out.
  agentRules: false,
  // TypeScript 7 ships without the JS compiler API, so `next build` must shell
  // out to the project-local tsc instead of loading it in-process.
  experimental: {
    useTypeScriptCli: true,
  },
  ...(process.env.NEXT_OUTPUT_STANDALONE === "true"
    ? { output: "standalone" as const }
    : {}),
};

export default nextConfig;
