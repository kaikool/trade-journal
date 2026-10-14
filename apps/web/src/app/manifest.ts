import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Trade Journal",
    short_name: "Trade Journal",
    description: "Private trading journal and analytics.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#08080a",
    theme_color: "#08080a",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icon-192.png?v=4", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png?v=4", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
