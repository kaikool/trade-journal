import { describe, expect, it } from "vitest";
import { createPostgresClient, postgresClientOptions } from "../src/db/postgres";

describe("serverless Postgres client", () => {
  it("uses one non-prepared TLS connection per warm instance", () => {
    expect(postgresClientOptions).toMatchObject({
      max: 1,
      prepare: false,
      ssl: "require",
    });
  });

  it("rejects a missing database URL before creating a client", () => {
    expect(() => createPostgresClient("")).toThrow("DATABASE_URL is required");
  });
});
