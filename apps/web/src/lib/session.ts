/** Shared token framing for Node route handlers and the Edge middleware. */
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export function sessionParts(token: string | undefined, now = Date.now()) {
  if (!token) return null;
  const match = /^(v2\.([0-9]{10})\.([0-9]{10})\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  const issued = Number(match[2]),
    expires = Number(match[3]);
  const seconds = Math.floor(now / 1000);
  if (issued > seconds + 30 || expires <= seconds || expires - issued !== SESSION_MAX_AGE)
    return null;
  return { message: match[1]!, signature: match[4]! };
}
