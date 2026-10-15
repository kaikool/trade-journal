"use client";

import { useCallback, useEffect, useState } from "react";
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
const PERSIST_PREFIX = "journal-api-cache-v1:";
const MAX_PERSIST_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getPersisted<T>(url: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${PERSIST_PREFIX}${url}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: T; timestamp: number };
    if (!parsed || typeof parsed.timestamp !== "number") {
      localStorage.removeItem(`${PERSIST_PREFIX}${url}`);
      return null;
    }
    if (Date.now() - parsed.timestamp > MAX_PERSIST_AGE_MS) {
      localStorage.removeItem(`${PERSIST_PREFIX}${url}`);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function setPersisted<T>(url: string, data: T) {
  if (typeof window === "undefined") return;
  if (url.includes("/api/auth") || url.includes("/export")) return;
  try {
    localStorage.setItem(
      `${PERSIST_PREFIX}${url}`,
      JSON.stringify({ data, timestamp: Date.now() }),
    );
  } catch {
    try {
      const keysToRemove: { key: string; time: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PERSIST_PREFIX)) {
          const item = localStorage.getItem(key);
          const time = item ? ((JSON.parse(item) as { timestamp?: number }).timestamp ?? 0) : 0;
          keysToRemove.push({ key, time });
        }
      }
      keysToRemove.sort((a, b) => a.time - b.time);
      const toDelete = keysToRemove.slice(0, Math.ceil(keysToRemove.length / 2));
      for (const item of toDelete) {
        localStorage.removeItem(item.key);
      }
      localStorage.setItem(
        `${PERSIST_PREFIX}${url}`,
        JSON.stringify({ data, timestamp: Date.now() }),
      );
    } catch {}
  }
}

export function clearApiCache(prefix?: string) {
  apiCache.clear();
  if (typeof window === "undefined") return;
  try {
    const target = prefix ? `${PERSIST_PREFIX}${prefix}` : PERSIST_PREFIX;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(target)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {}
}

/** Deduplicate concurrent reads and persist completed responses across app launches. */
export const useApi = <T>(url: string | null): ApiState<T> => {
  const cached = url ? (apiCache.get(url) as CacheItem<T> | undefined) : undefined;
  const persisted = !cached && url ? getPersisted<T>(url) : null;
  const initialData = cached?.data ?? persisted ?? null;

  if (persisted && url && !cached) {
    apiCache.set(url, { data: persisted, timestamp: Date.now() });
  }

  const [data, setData] = useState<T | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(url && !initialData));
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
    const currentPersisted = !currentCached ? getPersisted<T>(url) : null;
    const availableData = currentCached?.data ?? currentPersisted;

    if (availableData) {
      setData(availableData);
      setDataUrl(url);
      if (currentPersisted && !currentCached) {
        apiCache.set(url, { data: currentPersisted, timestamp: Date.now() });
      }
      const stillFresh = currentCached
        ? Date.now() - currentCached.timestamp < STALE_TIME_MS
        : false;
      if (stillFresh && tick === 0) {
        setLoading(false);
        return;
      }
    }

    let cancelled = false;
    if (!availableData) {
      setLoading(true);
    }
    setError(null);

    const request = acquireJson<T>(url);
    request.promise
      .then((body) => {
        if (cancelled) return;
        apiCache.set(url, { data: body, timestamp: Date.now() });
        setPersisted(url, body);
        setData(body);
        setDataUrl(url);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Network error");
          if (!availableData) setData(null);
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
    if (url) {
      apiCache.delete(url);
      if (typeof window !== "undefined") {
        try {
          localStorage.removeItem(`${PERSIST_PREFIX}${url}`);
        } catch {}
      }
    }
    setTick((value) => value + 1);
  }, [url]);

  const current = dataUrl === url;
  const currentCached = url ? (apiCache.get(url) as CacheItem<T> | undefined) : undefined;
  const effectiveData = (current ? data : null) ?? (currentCached?.data as T | null) ?? data;

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
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Load failed") ||
      msg.includes("Failed to fetch") ||
      msg.includes("NetworkError") ||
      msg.includes("aborted")
    ) {
      throw new Error("Request timed out or connection was interrupted. Please try again.");
    }
    throw err;
  }

  let data: (Record<string, unknown> & { error?: string }) | null = null;
  if (typeof response.text === "function") {
    const text = await response.text();
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown> & { error?: string }) : null;
    } catch {
      // Non-JSON response (e.g. 504 Gateway Timeout HTML page)
    }
  } else if (typeof response.json === "function") {
    try {
      data = (await response.json()) as Record<string, unknown> & { error?: string };
    } catch {
      // Non-JSON response
    }
  }

  if (!response.ok) {
    const errorMsg =
      data?.error ??
      (response.status === 504
        ? "Server timed out processing the request."
        : `Request failed (${response.status})`);
    throw new Error(errorMsg);
  }

  clearApiCache();
  return (data ?? {}) as T;
};
