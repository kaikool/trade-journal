import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { AUTH_COOKIE, passwordConfigured, verifySession } from "./auth";

export class RequestError extends Error {}
export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RequestError(message);
}

export const ok = (data: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(data, { ...init, headers });
};

export const bad = (message: string, status = 400) =>
  NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );

const safeErrorMessage = (message: string): string =>
  message
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[redacted]@")
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]{20,}\b/g, "[redacted-token]")
    .replace(/\b(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/Key \(([^)]+)\)=\(([^)]*)\)/g, "Key ($1)=([redacted])")
    .slice(0, 500);

/** Route-handler wrapper: uniform error JSON instead of HTML 500 pages. */
export const handler =
  <A extends unknown[]>(
    fn: (...args: A) => Promise<Response> | Response,
    options: { public?: boolean } = {},
  ) =>
  async (...args: A): Promise<Response> => {
    try {
      if (!passwordConfigured()) return bad("JOURNAL_PASSWORD is required", 503);
      if (!options.public) {
        const token = (await cookies()).get(AUTH_COOKIE)?.value;
        if (!verifySession(token)) return bad("Unauthorized", 401);
      }
      return await fn(...args);
    } catch (error) {
      if (error instanceof RequestError)
        return NextResponse.json({ error: error.message }, { status: 400 });

      const requestId = randomUUID();
      const rootCause =
        error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const databaseError = rootCause as {
        code?: unknown;
        severity?: unknown;
        table?: unknown;
        column?: unknown;
        constraint?: unknown;
      };
      const request = args[0] instanceof Request ? args[0] : undefined;
      console.error("[api] Request failed", {
        requestId,
        path: request ? new URL(request.url).pathname : undefined,
        errorName: error instanceof Error ? error.name : "UnknownError",
        causeName: rootCause instanceof Error ? rootCause.name : undefined,
        causeCode: typeof databaseError.code === "string" ? databaseError.code : undefined,
        causeSeverity:
          typeof databaseError.severity === "string" ? databaseError.severity : undefined,
        causeTable: typeof databaseError.table === "string" ? databaseError.table : undefined,
        causeColumn: typeof databaseError.column === "string" ? databaseError.column : undefined,
        causeConstraint:
          typeof databaseError.constraint === "string" ? databaseError.constraint : undefined,
        causeMessage:
          rootCause instanceof Error ? safeErrorMessage(rootCause.message) : "Internal error",
      });
      return NextResponse.json({ error: "Internal server error", requestId }, { status: 500 });
    }
  };
