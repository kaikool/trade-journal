"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error: unknown) => {
        console.error("[pwa] Service worker registration failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      });
  }, []);

  return null;
}
