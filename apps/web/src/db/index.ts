import { createPostgresDb, type JournalDb } from "./postgres";

type DatabaseGlobals = {
  __journalDb?: JournalDb;
  /** Test-only injection point; production never sets this value. */
  __journalTestDb?: JournalDb;
};

const globals = globalThis as unknown as DatabaseGlobals;

const createDb = (): JournalDb => {
  if (globals.__journalTestDb) return globals.__journalTestDb;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  return createPostgresDb(url).db;
};

/** Singleton across Next development reloads and warm Vercel invocations. */
export const db = globals.__journalDb ?? (globals.__journalDb = createDb());

export * from "./schema.pg";
