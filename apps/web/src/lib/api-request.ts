interface PendingRequest {
  controller: AbortController;
  promise: Promise<unknown>;
  users: number;
}

const pending = new Map<string, PendingRequest>();

/** Share only in-flight GETs. Completed financial data is never retained in a global cache. */
export function acquireJson<T>(url: string): { promise: Promise<T>; release: () => void } {
  let request = pending.get(url);
  if (!request) {
    const controller = new AbortController();
    const next: PendingRequest = { controller, users: 0, promise: Promise.resolve() };
    next.promise = fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        let body: { error?: string } | null = null;
        if (typeof response.text === "function") {
          const text = await response.text();
          try {
            body = text ? (JSON.parse(text) as { error?: string }) : null;
          } catch {
            // Non-JSON response
          }
        } else if (typeof response.json === "function") {
          try {
            body = (await response.json()) as { error?: string };
          } catch {
            // Non-JSON response
          }
        }
        if (!response.ok) {
          const errorMsg =
            body?.error ??
            (response.status === 504
              ? "Server timed out processing the request."
              : `Request failed (${response.status})`);
          throw new Error(errorMsg);
        }
        return (body ?? {}) as T;
      })
      .catch((err) => {
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
      })
      .finally(() => {
        if (pending.get(url) === next) pending.delete(url);
      });
    request = next;
    pending.set(url, request);
  }
  const shared = request;
  shared.users++;
  let released = false;
  return {
    promise: shared.promise as Promise<T>,
    release: () => {
      if (released) return;
      released = true;
      shared.users--;
      // React Strict Mode can immediately reattach the same subscriber.
      queueMicrotask(() => {
        if (shared.users === 0 && pending.get(url) === shared) {
          pending.delete(url);
          shared.controller.abort();
        }
      });
    },
  };
}
