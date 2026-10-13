import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import * as schema from "../../src/db/schema.pg";

const directory = new URL("../../drizzle/", import.meta.url);
const migration = readdirSync(directory)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort()
  .flatMap((name) =>
    readFileSync(new URL(name, directory), "utf8").split("--> statement-breakpoint"),
  )
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
