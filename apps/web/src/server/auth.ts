import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SESSION_MAX_AGE, sessionParts } from "@/lib/session";

/**
 * Single-user auth requires a non-empty JOURNAL_PASSWORD. Sessions have a signed
 * lifetime and random nonce; rotating the password invalidates all sessions.
 */
export const AUTH_COOKIE = "journal_session";

export const passwordConfigured = (): boolean => Boolean(process.env.JOURNAL_PASSWORD?.trim());

export const sessionToken = (): string => {
  if (!passwordConfigured()) throw new Error("JOURNAL_PASSWORD is required");
  const issued = Math.floor(Date.now() / 1000);
  const payload = `v2.${issued}.${issued + SESSION_MAX_AGE}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${createHmac("sha256", process.env.JOURNAL_PASSWORD!).update(payload).digest("hex")}`;
};

export const verifyPassword = (candidate: string): boolean => {
  if (!passwordConfigured()) return false;
  const expected = Buffer.from(process.env.JOURNAL_PASSWORD!, "utf8");
  const given = Buffer.from(candidate, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const verifySession = (token: string | undefined): boolean => {
  if (!passwordConfigured()) return false;
  const parts = sessionParts(token);
  if (!parts) return false;
  const expected = createHmac("sha256", process.env.JOURNAL_PASSWORD!)
    .update(parts.message)
    .digest();
  const given = Buffer.from(parts.signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
};
