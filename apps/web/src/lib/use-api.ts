"use client";

import { startTransition, useCallback, useEffect, useState } from "react";
import { acquireJson } from "./api-request";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

interface CacheItem<T> {
  data: T;
  timestamp: number;
}

const apiCache = new Map<string, CacheItem<unknown>>();
const STALE_TIME_MS = 60_000;

export function clearApiCache(prefix?: string) {
  if (!prefix) {
    apiCache.clear();
  } else {
    for (const key of apiCache.keys()) {
      if (key.startsWith(prefix)) apiCache.delete(key);
    }
  }
}

/** Deduplicate concurrent reads and cache completed responses for instant page transitions. */
export const useApi = <T>(url: string | null): ApiState<T> => {
  const cached = url ? (apiCache.get(url) as CacheItem<T> | undefined) : undefined;

  const [data, setData] = useState<T | null>(() => cached?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(url && !cached));
  const [tick, setTick] = useState(0);
  const [dataUrl, setDataUrl] = useState(url);

  useEffect(() => {
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      setDataUrl(null);
      return;
    }

    const currentCached = apiCache.get(url) as CacheItem<T> | undefined;
    if (currentCached) {
      setData(currentCached.data);
      setDataUrl(url);
      const stillFresh = Date.now() - currentCached.timestamp < STALE_TIME_MS;
      if (stillFresh && tick === 0) {
        setLoading(false);
        return;
      }
    }

    let cancelled = false;
    if (!currentCached) {
      setLoading(true);
    }
    setError(null);

    const request = acquireJson<T>(url);
    request.promise
      .then((body) => {
        if (cancelled) return;
        apiCache.set(url, { data: body, timestamp: Date.now() });
        // Render fresh data as a transition so React yields to the browser mid-render
        // instead of blocking the main thread for the whole page.
        startTransition(() => {
          setData(body);
          setDataUrl(url);
          setError(null);
          setLoading(false);
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Network error");
          if (!currentCached) setData(null);
          setDataUrl(url);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      request.release();
    };
  }, [url, tick]);

  useEffect(() => {
    if (!url) return;
    const changed = () => {
      clearApiCache();
      setTick((value) => value + 1);
    };
    const accountsChanged = () => {
      clearApiCache("/api/accounts");
      setTick((value) => value + 1);
    };
    window.addEventListener("journal-data-changed", changed);
    window.addEventListener("journal-accounts-changed", accountsChanged);
    return () => {
      window.removeEventListener("journal-data-changed", changed);
      window.removeEventListener("journal-accounts-changed", accountsChanged);
    };
  }, [url]);

  const refresh = useCallback(() => {
    if (url) apiCache.delete(url);
    setTick((value) => value + 1);
  }, [url]);

  const current = dataUrl === url;
  const currentCached = url ? (apiCache.get(url) as CacheItem<T> | undefined) : undefined;
  const effectiveData = current ? data : (currentCached?.data ?? null);

  return {
    data: effectiveData,
    error: current ? error : null,
    loading: Boolean(url) && (!effectiveData || (current && loading)),
    refresh,
  };
};

export const postJson = async <T = unknown>(
  url: string,
  body: unknown,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
): Promise<T> => {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  clearApiCache();
  return data;
};
