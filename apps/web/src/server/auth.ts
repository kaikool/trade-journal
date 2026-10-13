import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Single-user auth requires a non-empty JOURNAL_PASSWORD; the session cookie is an HMAC of the
 * password so rotating the password invalidates sessions.
 */
export const AUTH_COOKIE = "journal_session";

export const passwordConfigured = (): boolean => Boolean(process.env.JOURNAL_PASSWORD?.trim());

export const sessionToken = (): string => {
  if (!passwordConfigured()) throw new Error("JOURNAL_PASSWORD is required");
  return createHmac("sha256", process.env.JOURNAL_PASSWORD!).update("session-v1").digest("hex");
};

export const verifyPassword = (candidate: string): boolean => {
  if (!passwordConfigured()) return false;
  const expected = Buffer.from(process.env.JOURNAL_PASSWORD!, "utf8");
  const given = Buffer.from(candidate, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const verifySession = (token: string | undefined): boolean => {
  if (!passwordConfigured()) return false;
  if (!token) return false;
  const expected = Buffer.from(sessionToken(), "utf8");
  const given = Buffer.from(token, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
};
