import { expect, it } from "vitest";
import { createTestDatabase } from "./helpers/postgres";
it("keeps every journal table private even if PostgREST roles receive SELECT grants", async () => {
  const fixture = await createTestDatabase();
  try {
    await fixture.client.exec(
      "INSERT INTO accounts(id,name,kind,created_at) VALUES ('private','Private','manual','2026-01-01'); CREATE ROLE journal_anon NOLOGIN; GRANT USAGE ON SCHEMA public TO journal_anon; GRANT SELECT ON ALL TABLES IN SCHEMA public TO journal_anon;",
    );
    const policies = await fixture.client.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'",
    );
    expect(policies.rows).toHaveLength(23);
    expect(policies.rows.every((table) => table.relrowsecurity)).toBe(true);
    await fixture.client.exec("SET ROLE journal_anon");
    expect((await fixture.client.query("SELECT * FROM accounts")).rows).toHaveLength(0);
    await fixture.client.exec("RESET ROLE");
    expect((await fixture.client.query("SELECT * FROM accounts")).rows).toHaveLength(1);
  } finally {
    await fixture.client.exec("RESET ROLE");
    await fixture.close();
  }
});
