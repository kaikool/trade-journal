import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";
const fixture = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = fixture.db;
vi.resetModules();
const { db, settings, accounts, propAccounts, propEntries, propReceipts, propAudit } =
  await import("../src/db");
const { recordPayoutReceipt, settledPayout, sourceRecords } =
  await import("../src/server/the5ers/payouts");
const { cashMovements, cashSummary } = await import("../src/lib/prop-firms");
const { propData, mutatePropInTransaction } = await import("../src/server/prop-firms");
const payout = {
  id: "settlement-1",
  status: "completed",
  currency: "USD",
  amount: 1000,
  netAmount: 780,
  requestedAt: "2026-02-01T23:30:00Z",
  paidAt: "2026-02-02T01:00:00Z",
};
beforeEach(async () => {
  await db.delete(propAudit);
  await db.delete(propReceipts);
  await db.delete(propEntries);
  await db.delete(propAccounts);
  await db.delete(settings);
  await db.delete(accounts);
  await db.insert(accounts).values({
    id: "journal",
    name: "The5ers",
    kind: "import",
    currency: "USD",
    createdAt: "2026-01-01T00:00:00Z",
  });
  await db.insert(propAccounts).values({
    id: "funded",
    journalAccountId: "journal",
    name: "Funding phase",
    firm: "The5ers",
    currency: "USD",
    program: "funded",
    status: "active",
    openedOn: "2026-01-01",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  await db.insert(settings).values([
    { key: "the5ers:journal-links", value: JSON.stringify({ source: "journal" }) },
    { key: "timeZone", value: "Asia/Ho_Chi_Minh" },
  ]);
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await fixture.close();
});
const save = (
  source: unknown,
  confirmation?: { accountId: string; amount: string; receivedOn: string },
) => db.transaction((tx) => recordPayoutReceipt(tx, "source", source, confirmation));
it("posts explicit net settlement into the audited payout and receipt tables, once", async () => {
  expect(await save(payout)).toBe("imported");
  expect(await save(payout)).toBe("matched");
  const data = await propData();
  expect(data.entries).toHaveLength(1);
  expect(data.receipts).toHaveLength(1);
  expect(data.entries[0]).toMatchObject({
    status: "completed",
    amountMinor: 78000,
    splitBps: 10000,
    feeMinor: 0,
    accountId: "funded",
  });
  expect(data.receipts[0]).toMatchObject({ amountMinor: 78000, occurredOn: "2026-02-02" });
  expect(cashSummary(cashMovements(data.entries, data.receipts))).toMatchObject({
    received: 78000,
  });
  expect(await db.select().from(propAudit)).toHaveLength(3);
});
it("never treats a request amount/status as evidence of cash and supports explicit owner confirmation", async () => {
  const request = {
    id: "request-1",
    amount: 1000,
    status: "completed",
    createdAt: payout.requestedAt,
  };
  expect(settledPayout(request)).toBeUndefined();
  expect(await save(request)).toBe("pending");
  expect(await db.select().from(propReceipts)).toHaveLength(0);
  expect(
    await save(request, { accountId: "funded", amount: "780.00", receivedOn: "2026-02-03" }),
  ).toBe("imported");
  expect(
    await save(request, { accountId: "funded", amount: "780.00", receivedOn: "2026-02-03" }),
  ).toBe("matched");
  await expect(
    save(request, { accountId: "funded", amount: "790.00", receivedOn: "2026-02-03" }),
  ).rejects.toThrow("changed");
  expect((await db.select().from(propReceipts))[0]!.amountMinor).toBe(78000);
});
it("does not double count a manually recorded receipt and rolls back invalid confirmation", async () => {
  await save(payout);
  expect(await save({ ...payout, id: "another-provider-id" })).toBe("pending");
  await expect(
    save({ id: "invalid" }, { accountId: "funded", amount: "0x10", receivedOn: "2026-02-03" }),
  ).rejects.toThrow();
  await expect(
    save({ id: "bad-date" }, { accountId: "funded", amount: "1", receivedOn: "2026-02-30" }),
  ).rejects.toThrow();
  expect(await db.select().from(propEntries)).toHaveLength(1);
  expect(await db.select().from(propReceipts)).toHaveLength(1);
});
it("retains local reversals on later refreshes", async () => {
  await save(payout);
  const [entry] = await db.select().from(propEntries);
  await db.transaction((tx) =>
    mutatePropInTransaction(tx, {
      action: "receipt.add",
      id: "reversal",
      payoutId: entry!.id,
      revision: entry!.revision,
      kind: "reversal",
      amount: "80",
      occurredOn: "2026-02-04",
    }),
  );
  expect(await save(payout)).toBe("matched");
  const data = await propData();
  expect(data.receipts).toHaveLength(2);
  expect(cashSummary(cashMovements(data.entries, data.receipts))).toMatchObject({
    received: 70000,
  });
});
it("reads all supported purchase and payout page containers without dropping records", () => {
  expect(
    sourceRecords(
      {
        pages: [
          { data: [payout] },
          { data: { history: [payout] } },
          { data: { payouts: [payout] } },
        ],
      },
      "payouts",
    ),
  ).toHaveLength(3);
});
