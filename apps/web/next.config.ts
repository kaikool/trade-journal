import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@luxalgo/journal-core", "@luxalgo/journal-importers"],
  serverExternalPackages: ["postgres"],
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "recharts",
      "echarts",
      "@radix-ui/react-dialog",
      "@radix-ui/react-select",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-popover",
      "@radix-ui/react-tabs",
      "@radix-ui/react-dropdown-menu",
    ],
  },
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "../../outputs/**/*", "../../.runtime-backup*/**/*"],
  },
};

export default nextConfig;
