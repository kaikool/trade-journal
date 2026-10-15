"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { HoverHint } from "./ui/tooltip";
import { cn } from "@/lib/utils";

const AUTO_SYNC_STORAGE_KEY = "journal-last-auto-sync-at";
const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface SyncContextValue {
  syncing: boolean;
  lastSync: number | null;
  labelTime: string;
  performSync: (options?: { force?: boolean; all?: boolean }) => Promise<void>;
}

const SyncContext = createContext<SyncContextValue>({
  syncing: false,
  lastSync: null,
  labelTime: "",
  performSync: async () => {},
});

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "Never";
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function BackgroundSyncProvider({ children }: { children: React.ReactNode }) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [labelTime, setLabelTime] = useState("");
  const syncInProgressRef = useRef(false);

  const performSync = useCallback(async (options: { force?: boolean; all?: boolean } = {}) => {
    if (syncInProgressRef.current) return;
    syncInProgressRef.current = true;
    setSyncing(true);

    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: options.force, all: options.all }),
      });

      if (response.ok) {
        const now = Date.now();
        try {
          localStorage.setItem(AUTO_SYNC_STORAGE_KEY, String(now));
        } catch {}
        setLastSync(now);
        setLabelTime("just now");
        // Notify journal hooks to refresh views silently
        window.dispatchEvent(new Event("journal-data-changed"));
        window.dispatchEvent(new Event("journal-accounts-changed"));
      }
    } catch (err) {
      console.warn("[auto-sync] Background sync error:", err);
    } finally {
      syncInProgressRef.current = false;
      setSyncing(false);
    }
  }, []);

  // Initialize and check auto-sync on mount and visibility change
  useEffect(() => {
    let savedTime: number | null = null;
    try {
      const stored = localStorage.getItem(AUTO_SYNC_STORAGE_KEY);
      if (stored) savedTime = Number(stored);
    } catch {}

    if (savedTime && Number.isFinite(savedTime)) {
      setLastSync(savedTime);
      setLabelTime(formatRelativeTime(savedTime));
    }

    const checkAndTrigger = () => {
      const now = Date.now();
      let last = savedTime;
      try {
        const item = localStorage.getItem(AUTO_SYNC_STORAGE_KEY);
        if (item) last = Number(item);
      } catch {}

      if (!last || now - last >= AUTO_SYNC_INTERVAL_MS) {
        // Run background sync
        void performSync({ force: false });
      }
    };

    // Stagger initial check slightly to let initial page render finish instantly
    const initialTimer = setTimeout(() => {
      checkAndTrigger();
    }, 1500);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkAndTrigger();
      }
    };

    const onFocus = () => {
      checkAndTrigger();
    };

    // Periodic check every 2 minutes
    const interval = setInterval(() => {
      let currentLast: number | null = null;
      try {
        const stored = localStorage.getItem(AUTO_SYNC_STORAGE_KEY);
        if (stored) currentLast = Number(stored);
      } catch {}
      if (currentLast) {
        setLabelTime(formatRelativeTime(currentLast));
        if (Date.now() - currentLast >= AUTO_SYNC_INTERVAL_MS) {
          void performSync({ force: false });
        }
      }
    }, 120_000);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [performSync]);

  return (
    <SyncContext.Provider value={{ syncing, lastSync, labelTime, performSync }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useBackgroundSync() {
  return useContext(SyncContext);
}

export function GlobalSyncButton({
  className,
  iconOnly = false,
}: {
  className?: string;
  iconOnly?: boolean;
}) {
  const { syncing, labelTime, performSync } = useBackgroundSync();

  const tooltipText = syncing
    ? "Syncing data in background (trades, payouts, new accounts)..."
    : `Sync all accounts (Last: ${labelTime || "just now"}). Auto-syncs every 30m.`;

  return (
    <HoverHint content={tooltipText} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size={iconOnly ? "icon" : "sm"}
        disabled={syncing}
        onClick={() => void performSync({ force: true, all: true })}
        aria-label="Sync all accounts"
        className={cn(
          "relative text-muted-foreground hover:text-foreground transition-all",
          iconOnly ? "h-9 w-9 shrink-0" : "gap-1.5 h-8 px-2.5 text-xs font-medium",
          className,
        )}
      >
        <RefreshCw className={cn("h-4 w-4 shrink-0", syncing && "animate-spin text-foreground")} />
        {!iconOnly && <span className="truncate">{syncing ? "Syncing..." : "Sync"}</span>}
      </Button>
    </HoverHint>
  );
}
