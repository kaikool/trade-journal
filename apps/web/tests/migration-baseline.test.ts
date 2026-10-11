import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigrationFixture } from "./helpers/migration-fixture";

const scratch = mkdtempSync(join(tmpdir(), "journal-migration-baseline-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("synthetic SQLite migration baseline", () => {
  it("captures all original tables and stable financial/object fingerprints", () => {
    const fixture = createMigrationFixture(join(scratch, "baseline.db"));
    expect(Object.keys(fixture.counts)).toHaveLength(23);
    expect(Object.values(fixture.counts).every((count) => count > 0)).toBe(true);
    expect(fixture.counts.accounts).toBe(2);
    expect(fixture.counts.executions).toBeGreaterThan(4);
    expect(fixture.trades.some((trade) => trade.status === "open")).toBe(true);
    expect(fixture.trades.some((trade) => trade.status !== "open")).toBe(true);
    expect(fixture.attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.accounts.map((account) => account.currency).sort()).toEqual(["EUR", "USD"]);
  });
});
