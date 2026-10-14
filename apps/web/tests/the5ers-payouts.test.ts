import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";
const fixture = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = fixture.db;
vi.resetModules();
const { db, settings, accounts, propAccounts, propEntries, propReceipts, propAudit } =
  await import("../src/db");
const { recordPayoutReceipt, settledPayout, sourceRecords, payoutKey } =
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

it("reads withdrawals and normalizes explicit net payment without using the gross request amount", () => {
  const withdrawal = {
    withdrawalId: "withdrawal-1",
    status: "Paid",
    currency: "USD",
    amount: 1000,
    netPaid: "780.00",
    requestDate: "2026-02-01T10:00:00Z",
    paymentDate: "2026-02-02T10:00:00Z",
  };
  expect(sourceRecords({ pages: [{ data: { withdrawals: [withdrawal] } }] }, "payouts")).toEqual([
    withdrawal,
  ]);
  expect(settledPayout(withdrawal)).toMatchObject({ amountMinor: 78000, currency: "USD" });
  expect(settledPayout({ ...withdrawal, netPaid: undefined })).toBeUndefined();
  expect(settledPayout({ ...withdrawal, status: "approved" })).toBeUndefined();
});

it("combines imported The5ers finances and another firm's manual records in one ledger and the same cash calculations", async () => {
  await save(payout);
  const { reconcilePurchases } = await import("../src/server/the5ers/journal");
  await db.transaction(async (tx) => {
    await reconcilePurchases(
      tx,
      [
        {
          placedAt: "2026-02-01T10:00:00Z",
          status: "completed",
          price: 100,
          currency: "USD",
          items: [
            { name: "Evaluation", productType: "evaluation", creditsApplied: 0, netPaid: 100 },
          ],
        },
      ],
      "UTC",
    );
    await mutatePropInTransaction(tx, {
      action: "account.save",
      revision: 0,
      id: "manual-funded",
      firm: "FTMO",
      name: "Manual funding",
      currency: "USD",
      program: "funded",
      status: "active",
      openedOn: "2026-01-01",
    });
    await mutatePropInTransaction(tx, {
      action: "entry.save",
      revision: 0,
      id: "manual-expense",
      firm: "FTMO",
      accountId: "manual-funded",
      kind: "expense",
      category: "evaluation",
      currency: "USD",
      amount: "100",
      occurredOn: "2026-02-01",
    });
    await mutatePropInTransaction(tx, {
      action: "entry.save",
      revision: 0,
      id: "manual-payout",
      firm: "FTMO",
      accountId: "manual-funded",
      kind: "payout",
      currency: "USD",
      amount: "220",
      splitPercent: "100",
      fee: "0",
      status: "approved",
      occurredOn: "2026-02-01",
    });
  });
  let data = await propData();
  const entry = data.entries.find((e) => e.id === "manual-payout")!;
  await db.transaction((tx) =>
    mutatePropInTransaction(tx, {
      action: "receipt.add",
      id: "manual-receipt",
      payoutId: entry.id,
      revision: entry.revision,
      kind: "receipt",
      amount: "220",
      occurredOn: "2026-02-02",
    }),
  );
  data = await propData();
  const cash = cashMovements(data.entries, data.receipts);
  expect(cashSummary(cash)).toMatchObject({ spent: 20000, received: 100000, net: 80000, roi: 4 });
  expect(cashSummary(cash.filter((row) => row.firm === "The5ers"))).toMatchObject({
    spent: 10000,
    received: 78000,
    net: 68000,
  });
  expect(cashSummary(cash.filter((row) => row.firm === "FTMO"))).toMatchObject({
    spent: 10000,
    received: 22000,
    net: 12000,
  });
  expect(data.receipts).toHaveLength(2);
  expect(await save(payout)).toBe("matched");
  expect(
    cashSummary(cashMovements((await propData()).entries, (await propData()).receipts)),
  ).toMatchObject({ received: 100000 });
});

it("does not merge paid withdrawals with placeholder payout IDs and reimports them idempotently", async () => {
  const first = { ...payout, id: undefined, payoutId: "N/A", amount: 100, netAmount: 100 };
  const second = { ...first, amount: 200, netAmount: 200 };
  expect(payoutKey("source", first)).not.toBe(payoutKey("source", second));
  expect(await save(first)).toBe("imported");
  expect(await save(second)).toBe("imported");
  expect(await save(first)).toBe("matched");
  const data = await propData();
  expect(data.receipts).toHaveLength(2);
  expect(cashSummary(cashMovements(data.entries, data.receipts)).received).toBe(30000);
});

it("uses a real payment ID when payout IDs are unavailable and retains existing real IDs", () => {
  const record = { payoutId: "N/A", paymentId: "payment-1" };
  expect(payoutKey("source", record)).toBe(payoutKey("source", { id: "payment-1" }));
  expect(payoutKey("source", { id: "known", paymentId: "different" })).toBe(
    payoutKey("source", { id: "known" }),
  );
});
it("records owner-confirmed terminal payouts without inventing settlement dates, once", async () => {
  for (const [index, status] of ["paid", "completed", "received", "settled"].entries()) {
    const source = {
      id: `confirmed-${index}`,
      status,
      currency: "USD",
      netAmount: 100 + index,
      ownerConfirmedPaid: true,
    };
    expect(await save(source)).toBe("imported");
    expect(await save(source)).toBe("matched");
  }
  const data = await propData();
  expect(data.receipts).toHaveLength(4);
  expect(data.entries.every((entry) => entry.notes.startsWith("[request-date-unknown]"))).toBe(
    true,
  );
  const movements = cashMovements(data.entries, data.receipts);
  expect(movements.every((row) => row.date === null)).toBe(true);
  expect(cashSummary(movements).received).toBe(40600);
});
it("accepts floating point noise but rejects real fractions of a cent", () => {
  expect(settledPayout({ ...payout, netAmount: 1684.8499999999997 })?.amountMinor).toBe(168485);
  expect(settledPayout({ ...payout, netAmount: 780.001 })).toBeUndefined();
});
it("keeps historical cash for archived funded accounts", async () => {
  const { eq } = await import("drizzle-orm");
  await db.update(propAccounts).set({ archived: true }).where(eq(propAccounts.id, "funded"));
  expect(await save(payout)).toBe("imported");
  expect((await propData()).receipts).toHaveLength(1);
});
it("reports an opening-date conflict without changing a manually configured account", async () => {
  const { eq } = await import("drizzle-orm");
  await db
    .update(propAccounts)
    .set({ openedOn: "2026-03-01" })
    .where(eq(propAccounts.id, "funded"));
  let reason = "";
  expect(
    await db.transaction((tx) =>
      recordPayoutReceipt(
        tx,
        "source",
        { ...payout, ownerConfirmedPaid: true },
        undefined,
        (value) => {
          reason = value;
        },
      ),
    ),
  ).toBe("pending");
  expect(reason).toBe("opening-date");
  expect((await propData()).accounts[0]?.openedOn).toBe("2026-03-01");
});
it("corrects an untouched imported opening bound when the confirmed payout proves earlier history", async () => {
  const { eq } = await import("drizzle-orm");
  await db
    .update(propAccounts)
    .set({ id: "the5ers_source", openedOn: "2026-03-01" })
    .where(eq(propAccounts.id, "funded"));
  const [account] = await db.select().from(propAccounts);
  await db.insert(propAudit).values({
    id: "import-audit",
    entityType: "account",
    entityId: account!.id,
    beforeJson: "null",
    afterJson: JSON.stringify(account),
    reason: "Imported verified The5ers funding phase from saved account metadata",
    createdAt: account!.createdAt,
  });
  expect(await save({ ...payout, ownerConfirmedPaid: true })).toBe("imported");
  expect((await propData()).accounts[0]?.openedOn).toBe("2026-02-02");
  expect(await save({ ...payout, ownerConfirmedPaid: true })).toBe("matched");
});
