import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.pg";

export const postgresClientOptions = {
  max: 1,
  prepare: false,
  ssl: "require" as const,
  connect_timeout: 10,
  idle_timeout: 20,
};

export const createPostgresClient = (url: string) => {
  if (!url.trim()) throw new Error("DATABASE_URL is required");
  return postgres(url, postgresClientOptions);
};

export const createPostgresDb = (url: string) => {
  const client = createPostgresClient(url);
  return { client, db: drizzle(client, { schema }) };
};

export type JournalDb = ReturnType<typeof createPostgresDb>["db"];
export type JournalTransaction = Parameters<Parameters<JournalDb["transaction"]>[0]>[0];
/** Shared query surface; transaction helpers must never fall back to the global client. */
export type JournalExecutor = Pick<JournalDb, "select" | "insert" | "update" | "delete">;
