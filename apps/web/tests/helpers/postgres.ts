import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import * as schema from "../../src/db/schema.pg";

const migration = readFileSync(
  new URL("../../drizzle/0000_ancient_starjammers.sql", import.meta.url),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

export async function createTestDatabase() {
  const client = new PGlite();
  for (const statement of migration) await client.exec(statement);
  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.close(),
  };
}
