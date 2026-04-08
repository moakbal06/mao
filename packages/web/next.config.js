/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@moakbal/mao-core",
    "@moakbal/mao-plugin-agent-claude-code",
    "@moakbal/mao-plugin-agent-opencode",
    "@moakbal/mao-plugin-runtime-tmux",
    "@moakbal/mao-plugin-scm-github",
    "@moakbal/mao-plugin-tracker-github",
    "@moakbal/mao-plugin-tracker-linear",
    "@moakbal/mao-plugin-workspace-worktree",
  ],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
