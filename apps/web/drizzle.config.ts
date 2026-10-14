import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

// Match Next.js local configuration; existing shell/Vercel variables take precedence.
if (existsSync(".env.local")) loadEnvFile(".env.local");

const url = process.env.DIRECT_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.pg.ts",
  out: "./drizzle",
  dbCredentials: url ? { url } : undefined,
  strict: true,
  verbose: true,
});
