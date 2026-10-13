import { eq } from "drizzle-orm";
import { db, settings } from "@/db";

const KEY = "auth:login-attempts";
const WINDOW_MS = 60_000;
const LIMIT = 10;
/** A shared single-user login bucket. Do not trust spoofable forwarded-IP headers. */
export async function takeLoginAttempt(now = Date.now()): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: KEY, value: JSON.stringify({ start: now, count: 0 }) })
      .onConflictDoNothing();
    const [row] = await tx.select().from(settings).where(eq(settings.key, KEY)).for("update");
    const saved = JSON.parse(row!.value) as { start: number; count: number };
    const bucket =
      now >= saved.start + WINDOW_MS || now < saved.start ? { start: now, count: 0 } : saved;
    if (bucket.count >= LIMIT)
      return Math.max(1, Math.ceil((bucket.start + WINDOW_MS - now) / 1000));
    bucket.count++;
    await tx
      .update(settings)
      .set({ value: JSON.stringify(bucket) })
      .where(eq(settings.key, KEY));
    return 0;
  });
}
