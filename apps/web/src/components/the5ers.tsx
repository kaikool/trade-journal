"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sourceStatus, defaultSourceVisible } from "@/lib/the5ers-status";
import { continueModuleSync, type ModuleSyncProgress } from "@/lib/the5ers-sync-runner";
import { useApi, postJson } from "@/lib/use-api";
import { Badge } from "./ui/badge";
import {
  normalizePurchase,
  sourceInstant,
  sourceObject,
  sourceFields,
} from "@/lib/the5ers-normalize";
import { fromMinor, type PropData } from "@/lib/prop-firms";
import { fmtMoney } from "@/lib/utils";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { MonetaryValue, usePrivacy } from "./privacy";
import type { SourceAccount, Selection, SourceSnapshot } from "@/server/the5ers/data";
interface Overview {
  timeZone?: string;
  configured: boolean;
  connected: boolean;
  canRefresh: boolean;
  error?: string;
  selection: Selection[];
  snapshots: SourceSnapshot[];
  cashSnapshots?: SourceSnapshot[];
  cashSelection?: Selection[];
  cash?: {
    complete: boolean;
    expensesComplete?: boolean;
    failures: { id: string; label: string }[];
    retrievedAt?: string;
    synced?: number;
    checked?: number;
    total?: number;
    remaining?: number;
    payouts?: {
      found: number;
      paid: number;
      recorded: number;
      missingSettlement: number;
      blocked?: Record<string, number>;
    };
  } | null;
  purchases?: unknown;
  moduleSync?: {
    complete: boolean;
    saved: number;
    total: number;
    failed: number;
    remaining: number;
    projectionFailed?: number;
    updatedAt?: string;
    errors?: { message?: string }[];
  } | null;
}
const heading = (name: string) =>
  name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const accountValue = (account: SourceAccount, ...keys: string[]) => {
  const source = obj(account.source);
  return keys.map((key) => source[key]).find((value) => value !== undefined);
};
const cash = (value: unknown, currency?: string) => {
  const amount = num(value);
  if (amount === null) return "Unavailable";
  return currency
    ? new Intl.NumberFormat("en", { style: "currency", currency }).format(amount)
    : `${amount} (currency unavailable)`;
};
export function formatSourceDate(value: unknown, timeZone: string) {
  const instant = sourceInstant(value);
  return instant
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(instant))
    : "Date unavailable";
}
export function The5ersBalance({
  value,
  currency,
  showInitialBalance = false,
}: {
  value: unknown;
  currency?: string;
  showInitialBalance?: boolean;
}) {
  const envelope = sourceObject(value),
    data = sourceObject(envelope.data ?? envelope);
  const code = typeof envelope.currency === "string" ? envelope.currency : currency;
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm">
      {[
        ["Starting balance", showInitialBalance ? data.initialBalance : undefined],
        ["Balance", data.balance],
        ["Equity", data.equity],
        ["Effective balance", data.equity === undefined ? data.effectiveBalance : undefined],
        ["Net P&L", data.profitAndLoss],
        ["Today", data.dailyProfitAndLoss],
      ]
        .filter(([, amount]) => amount !== undefined)
        .map(([label, amount]) => (
          <div key={String(label)}>
            <dt className="text-xs text-muted-foreground">{String(label)}</dt>
            <dd className="tnum mt-1 font-medium">
              <MonetaryValue>{cash(amount, code)}</MonetaryValue>
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function The5ersPurchases({ value, timeZone }: { value: unknown; timeZone: string }) {
  const privacy = usePrivacy();
  if (privacy) return <p>Turn off privacy mode to view source data.</p>;
  const history = sourceObject(value);
  const pages = Array.isArray(history.pages) ? history.pages : [value];
  const orders = pages.flatMap((page) => {
    const envelope = sourceObject(page),
      body = sourceObject(envelope.data ?? envelope);
    return Array.isArray(body.purchases) ? body.purchases : [];
  });
  return (
    <div className="space-y-3">
      {typeof history.imported === "number" && (
        <p className="text-sm text-muted-foreground">
          {history.imported} added to spending · {String(history.pending ?? 0)} need review
        </p>
      )}
      {orders.map((order, index) => {
        const purchase = normalizePurchase(order);
        return (
          <div key={index} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm font-medium">{purchase?.name ?? "Program purchase"}</p>
              <Badge variant="secondary">{heading(purchase?.status ?? "Unknown")}</Badge>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {formatSourceDate(purchase?.placedAt, timeZone)} · {timeZone}
              </p>
              <p className="tnum text-sm font-medium">
                {purchase && purchase.cashVerified
                  ? fmtMoney(
                      Number(fromMinor(purchase.amountMinor, purchase.currency)),
                      purchase.currency,
                    )
                  : "Amount needs review"}
              </p>
            </div>
            {purchase?.refunded && (
              <p className="mt-2 text-xs text-muted-foreground">
                Contains refunded items. Refund date needs review.
              </p>
            )}
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Order details</summary>
              <div className="mt-2">
                <SourceValue value={order} />
              </div>
            </details>
          </div>
        );
      })}
      {!orders.length && <p className="text-sm text-muted-foreground">No purchases found.</p>}
    </div>
  );
}
export function The5ersPayouts({
  value,
  sourceAccountId,
}: {
  value: unknown;
  sourceAccountId: string;
}) {
  const ledger = useApi<PropData>("/api/prop-firms");
  const [selected, setSelected] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<Set<string>>(() => new Set());
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [receivedOn, setReceivedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const privacy = usePrivacy();
  if (privacy) return <p>Turn off privacy mode to view source data.</p>;
  const history = obj(value);
  const rows = (Array.isArray(history.rows) ? history.rows : []) as {
    key: string;
    source: unknown;
    status: string;
  }[];
  const accounts = (ledger.data?.accounts ?? []).filter(
    (a) =>
      a.firm === "The5ers" &&
      !a.archived &&
      ["funded", "instant_funded", "live"].includes(a.program),
  );
  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await postJson("/api/the5ers", {
        action: "payout.confirm",
        id: sourceAccountId,
        payoutKey: selected,
        propAccountId: accountId,
        amount,
        receivedOn,
      });
      setRecorded((saved) => new Set([...saved, selected]));
      setSelected(null);
      setNotice("Receipt recorded. Payouts received has been updated.");
      window.dispatchEvent(new Event("journal-data-changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Settled payouts with an explicit net amount and payment date are added to your ledger.
        Confirm actual money received for other records. Requests alone do not count as cash
        received.
      </p>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {rows.map((row) => (
        <div key={row.key} className="rounded-md border p-3 space-y-3">
          <Badge variant="secondary">
            {row.status === "pending" && !recorded.has(row.key)
              ? "Confirm settlement"
              : "Recorded in ledger"}
          </Badge>
          <details>
            <summary className="cursor-pointer text-sm">Payout details</summary>
            <SourceValue value={row.source} />
          </details>
          {row.status === "pending" && !recorded.has(row.key) && selected !== row.key && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setSelected(row.key);
                setAmount("");
                setReceivedOn("");
                setAccountId(accounts.length === 1 ? accounts[0]!.id : "");
                setError("");
              }}
            >
              Record money received
            </Button>
          )}
          {selected === row.key && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="block text-sm">
                Funded prop account
                <select
                  required
                  aria-label="Funded prop account"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="mt-1 block w-full rounded-md border bg-background p-2"
                >
                  <option value="">Choose account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </select>
              </label>
              {!accounts.length && (
                <p className="text-sm">
                  Add or link a funded The5ers account in{" "}
                  <Link href="/prop-firms" className="underline">
                    Prop firms
                  </Link>{" "}
                  first.
                </p>
              )}
              <label className="block text-sm">
                Actual amount received (after split and fees)
                <Input
                  required
                  aria-label="Actual amount received"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                Date received
                <Input
                  required
                  aria-label="Date received"
                  type="date"
                  max={ledger.data?.today}
                  value={receivedOn}
                  onChange={(e) => setReceivedOn(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !accounts.length}>
                  {busy ? "Recording…" : "Confirm receipt"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setSelected(null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      ))}
      {!rows.length && <p className="text-sm">No payouts returned for this account.</p>}
    </div>
  );
}

export function The5ersProgramSummary({ value }: { value: unknown }) {
  const privacy = usePrivacy();
  if (privacy) return <p>Turn off privacy mode to view source data.</p>;
  const envelope = sourceFields(value),
    data = sourceFields(envelope.data ?? value);
  const currency = typeof envelope.currency === "string" ? envelope.currency : undefined;
  const fields = Object.entries(obj(envelope.data ?? value)).filter(
    ([key]) =>
      !["name", "currency", "freshness", "warnings", "complete"].includes(key.toLowerCase()),
  );
  const display = (raw: unknown, key: string): string | null => {
    if (typeof raw === "boolean") return raw ? "Yes" : "No";
    if (typeof raw === "string") return raw;
    if (typeof raw === "number") {
      const field = key.replace(/[_ ]/g, "").toLowerCase();
      if (field === "winrate") return `${(raw * 100).toFixed(1)}%`;
      if (
        [
          "grossprofit",
          "grossloss",
          "totalnetprofit",
          "bestprofit",
          "biggestloss",
          "avgprofit",
          "avgloss",
          "expectancy",
          "totalfees",
        ].includes(field)
      )
        return cash(raw, currency);
      return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(raw);
    }
    const item = sourceFields(raw);
    if (typeof item.value !== "number") return null;
    if (item.unit === "percent") return `${item.value}%`;
    if (item.unit === "currency")
      return currency ? cash(item.value, currency) : `${item.value} (currency unavailable)`;
    return `${item.value}${typeof item.unit === "string" ? ` ${item.unit}` : ""}`;
  };
  return (
    <div className="space-y-3">
      {typeof data.name === "string" && <p className="text-sm font-medium">{data.name}</p>}
      <dl className="grid grid-cols-2 gap-3">
        {fields.map(([key, raw]) => {
          const text = display(raw, key);
          return text === null ? null : (
            <div key={key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{heading(key)}</dt>
              <dd className="mt-1 break-words text-sm font-medium tnum">
                <MonetaryValue>{text}</MonetaryValue>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function useSource(url = "/api/the5ers") {
  const state = useApi<Overview>(url);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The5ers request failed.");
    } finally {
      setBusy(false);
    }
  };
  const imported = useRef(new Set<string>());
  useEffect(() => {
    const eligible = (state.data?.snapshots ?? []).filter(
      (snapshot) => snapshot.canImportSnapshot && !imported.current.has(snapshot.account.id),
    );
    if (!eligible.length) return;
    for (const snapshot of eligible) imported.current.add(snapshot.account.id);
    void run(async () => {
      for (const snapshot of eligible)
        await postJson("/api/the5ers", { action: "snapshot.import", id: snapshot.account.id });
      window.dispatchEvent(new Event("journal-data-changed"));
    });
  }, [state.data]);
  return {
    ...state,
    busy,
    run,
    setNotice,
    error: error ?? state.error ?? state.data?.error,
    notice,
  };
}
function Messages({ state }: { state: ReturnType<typeof useSource> }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="text-sm">
          {state.notice}
        </p>
      )}
    </>
  );
}
/** Curated source payload: protocol envelopes stay out of normal account/finance views. */
function SourceValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const privacy = usePrivacy();
  if (privacy && depth === 0)
    return (
      <span aria-label="Source financial data hidden">
        Turn off privacy mode to view source data.
      </span>
    );
  if (value === null || value === undefined) return <span>Unavailable</span>;
  if (typeof value !== "object")
    return (
      <span className="break-words">
        {typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}
      </span>
    );
  if (depth > 6) return <span>Additional nested details</span>;
  if (Array.isArray(value))
    return (
      <div className="space-y-3">
        {value.slice(0, 100).map((row, index) => (
          <div key={index} className="rounded-md border p-3">
            <SourceValue value={row} depth={depth + 1} />
          </div>
        ))}
        {value.length > 100 && <p>Showing 100 of {value.length} records.</p>}
        {!value.length && <p>No records returned.</p>}
      </div>
    );
  const record = obj(value);
  if (record.pages) return <SourceValue value={record.pages} depth={depth + 1} />;
  if (record.data)
    return (
      <div className="space-y-2">
        {typeof record.currency === "string" && (
          <p className="text-xs text-muted-foreground">Currency: {record.currency}</p>
        )}
        <SourceValue value={record.data} depth={depth + 1} />
      </div>
    );
  const excluded = [
    "contract_version",
    "request_context",
    "operation",
    "pagination",
    "source",
    "freshness",
    "warnings",
    "complete",
  ];
  return (
    <dl className="space-y-2">
      {Object.entries(record)
        .filter(([key]) => !excluded.includes(key))
        .map(([key, item]) => (
          <div key={key} className="grid gap-1 sm:grid-cols-[minmax(100px,1fr)_2fr]">
            <dt className="text-sm text-muted-foreground">{heading(key)}</dt>
            <dd className="min-w-0 text-sm">
              <SourceValue value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function The5ersConnection() {
  const state = useSource("/api/the5ers?view=connection"),
    overview = state.data;
  const privacy = usePrivacy();
  return (
    <Card>
      <CardHeader>
        <CardTitle>The5ers connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Read-only The5ers Hub connection. Use the sync button below to import all accounts,
          expenses, payouts, and trade history into the database. Manage account visibility in
          Accounts.
        </p>
        <Messages state={state} />
        {overview && !overview.configured && (
          <p className="text-sm">JOURNAL_SECRET is missing on this server.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={state.busy || state.loading}
            onClick={() =>
              void state.run(async () => {
                const result = await postJson<{ url: string }>("/api/the5ers", {
                  action: "connect",
                });
                window.location.assign(result.url);
              })
            }
          >
            {overview?.connected ? "Reconnect The5ers" : "Connect The5ers"}
          </Button>
          <Button
            variant="outline"
            disabled={state.busy || state.loading}
            onClick={() =>
              void state.run(async () => {
                const result = await postJson<{ message: string }>("/api/the5ers", {
                  action: "check",
                });
                state.setNotice(result.message);
              })
            }
          >
            Check connection
          </Button>
          {overview?.connected && (
            <Button
              variant="outline"
              disabled={state.busy}
              onClick={() =>
                void state.run(async () => {
                  await postJson("/api/the5ers", { action: "disconnect" });
                  state.refresh();
                })
              }
            >
              Disconnect
            </Button>
          )}
        </div>
        {overview?.connected && (
          <>
            <p className="text-sm text-muted-foreground">
              Connected {!overview.canRefresh ? " · Reconnect required when access expires" : ""}
            </p>
            <div className="space-y-3 rounded-md border p-4 bg-muted/20">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold">Sync all The5ers data into Database</p>
                  <p className="text-xs text-muted-foreground">
                    Automatically sync all accounts, challenge expenses, financial payouts, and
                    position history into the database.
                  </p>
                </div>
                <Button
                  className="mt-2 shrink-0 sm:mt-0 font-medium"
                  disabled={state.busy}
                  onClick={() =>
                    void state.run(async () => {
                      state.setNotice("Initializing all The5ers accounts in database...");
                      await postJson("/api/the5ers", { action: "sync.init" });
                      window.dispatchEvent(new Event("journal-data-changed"));

                      state.setNotice("Syncing expenses and purchases...");
                      try {
                        await postJson("/api/the5ers", { action: "purchases.sync" });
                      } catch {}
                      window.dispatchEvent(new Event("journal-data-changed"));

                      state.setNotice("Syncing payouts and financial cash history...");
                      let previousRemaining = Infinity;
                      for (let batch = 0; batch < 90; batch++) {
                        const result = await postJson<{
                          data: {
                            complete: boolean;
                            remaining?: number;
                            checked?: number;
                            total?: number;
                          };
                        }>("/api/the5ers", { action: "cash.sync" });
                        state.refresh();
                        window.dispatchEvent(new Event("journal-data-changed"));
                        if (result.data.complete) break;
                        state.setNotice(
                          result.data.checked != null
                            ? `Financial history: ${result.data.checked}/${result.data.total} account histories saved.`
                            : "Syncing financial history...",
                        );
                        if (!result.data.remaining || result.data.remaining >= previousRemaining)
                          break;
                        previousRemaining = result.data.remaining;
                      }

                      state.setNotice("Syncing module sections and trade history...");
                      await continueModuleSync(
                        async () =>
                          (
                            await postJson<{ data: ModuleSyncProgress }>("/api/the5ers", {
                              action: "modules.sync",
                            })
                          ).data,
                        (result) => {
                          if (!result.busy) {
                            state.refresh();
                            window.dispatchEvent(new Event("journal-data-changed"));
                          }
                          state.setNotice(
                            result.busy
                              ? "Saving The5ers position history into database..."
                              : result.complete
                                ? "Completed! All The5ers accounts and records have been successfully saved into the database."
                                : `Module sections saved: ${result.saved}/${result.total}. ${result.failed ?? 0} source reads failed.`,
                          );
                        },
                      );
                      state.refresh();
                      window.dispatchEvent(new Event("journal-data-changed"));
                    })
                  }
                >
                  Sync all data
                </Button>
              </div>

              {overview.moduleSync && (
                <p className="text-xs text-muted-foreground">
                  Module sections saved: {overview.moduleSync.saved}/{overview.moduleSync.total}
                  {overview.moduleSync.failed
                    ? ` · ${overview.moduleSync.failed} source reads failed`
                    : ""}
                </p>
              )}
              {(overview.moduleSync?.updatedAt ?? overview.cash?.retrievedAt) && (
                <p className="text-xs text-muted-foreground">
                  Last attempt:{" "}
                  {formatSourceDate(
                    overview.moduleSync?.updatedAt ?? overview.cash?.retrievedAt,
                    overview.timeZone ?? "UTC",
                  )}
                </p>
              )}
              {overview.moduleSync?.errors?.[0]?.message && (
                <p className="text-sm text-destructive">{overview.moduleSync.errors[0].message}</p>
              )}
              {overview.cash?.checked != null && (
                <p className="text-xs text-muted-foreground">
                  Account histories: {overview.cash.checked}/{overview.cash.total}
                </p>
              )}
              {overview.cash?.payouts && (
                <p className="text-xs text-muted-foreground">
                  Payouts found: {overview.cash.payouts.found} · Recorded receipts:{" "}
                  {overview.cash.payouts.recorded}
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-1 border-t">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() =>
                    void state.run(async () => {
                      const result = await postJson<{
                        data: { imported: number; matched: number; pending: number };
                      }>("/api/the5ers", { action: "purchases.sync" });
                      state.refresh();
                      window.dispatchEvent(new Event("journal-data-changed"));
                      state.setNotice(
                        `Expenses: ${result.data.imported} imported, ${result.data.matched} already linked.`,
                      );
                    })
                  }
                >
                  Sync expenses
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.busy || privacy}
                  onClick={() =>
                    void state.run(async () => {
                      const response = await fetch("/api/the5ers?view=payout-contract", {
                        cache: "no-store",
                      });
                      const report = await response.json();
                      if (!response.ok)
                        throw new Error(
                          typeof report.error === "string"
                            ? report.error
                            : "Could not read the payout contract.",
                        );
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
                      );
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = "the5ers-connection-report.json";
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  Download connection report
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <Link href="/accounts" className="underline">
                Manage accounts
              </Link>
              <Link href="/prop-firms" className="underline">
                Program & finances
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
export function The5ersAccounts({ onLinked }: { onLinked?: () => void }) {
  const state = useSource();
  const journal = useApi<{ accounts: { id: string; name: string; currency: string }[] }>(
    "/api/accounts?summary=1",
  );
  const [links, setLinks] = useState<Record<string, string>>({});
  const [inventory, setInventory] = useState<SourceAccount[] | null>(null),
    [chosen, setChosen] = useState<string[]>([]),
    [auto, setAuto] = useState(false),
    [search, setSearch] = useState(""),
    [statusFilter, setStatusFilter] = useState("current"),
    [coverage, setCoverage] = useState({ complete: true, warnings: [] as string[] }),
    [page, setPage] = useState(0);
  const load = () =>
    state.run(async () => {
      const result = await postJson<{
        accounts: SourceAccount[];
        complete: boolean;
        warnings: string[];
      }>("/api/the5ers", {
        action: "accounts",
      });
      setInventory(result.accounts);
      setCoverage({ complete: result.complete, warnings: result.warnings });
      setChosen(state.data?.selection.map((a) => a.id) ?? []);
      setLinks(
        Object.fromEntries(
          (state.data?.selection ?? [])
            .filter((a) => a.journalAccountId)
            .map((a) => [a.id, a.journalAccountId!]),
        ),
      );
      setAuto(state.data?.selection.some((a) => a.autoSync) ?? false);
      setPage(0);
    });
  const loaded = useRef(false);
  useEffect(() => {
    if (state.data?.connected && !loaded.current) {
      loaded.current = true;
      void load();
    }
  }, [state.data?.connected]);
  if (state.loading) return null;
  if (!state.data?.connected)
    return (
      <p className="px-4 text-sm text-muted-foreground">
        <Link href="/settings#the5ers" className="underline">
          Connect The5ers in Settings
        </Link>{" "}
        to add your Hub accounts.{state.error && <span role="alert"> {state.error}</span>}
      </p>
    );
  const rows = (inventory ?? []).filter(
    (a) =>
      (statusFilter === "all" ||
        (statusFilter === "current"
          ? defaultSourceVisible(a.status)
          : sourceStatus(a.status) === statusFilter)) &&
      `${a.label} ${a.platform} ${a.status ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Card className="m-4">
      <CardHeader>
        <CardTitle>The5ers accounts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.error && (
          <div role="alert" className="rounded-lg border p-3 text-sm">
            <p className="font-medium">We couldn’t complete this request</p>
            <p className="mt-1">
              Try again. If it keeps happening, check your The5ers connection in Settings.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-1 break-words">{state.error}</p>
            </details>
          </div>
        )}
        {state.notice && (
          <p role="status" className="text-sm">
            {state.notice}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Choose your The5ers accounts, then link them to your journal.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={state.busy} onClick={() => void load()}>
            Refresh account list
          </Button>
          <Link href="/settings#the5ers" className="self-center text-sm underline">
            Connection settings
          </Link>
        </div>
        {inventory && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                aria-label="Search The5ers accounts"
                placeholder="Search accounts"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                className="w-full sm:max-w-sm"
              />
              <select
                aria-label="Filter The5ers account status"
                className="w-full rounded-md border bg-background p-2 text-sm sm:w-auto"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(0);
                }}
              >
                <option value="current">
                  Active / available (
                  {inventory.filter((a) => defaultSourceVisible(a.status)).length})
                </option>
                <option value="all">All statuses ({inventory.length})</option>
                {[...new Set(inventory.map((a) => sourceStatus(a.status)))].sort().map((status) => (
                  <option key={status} value={status}>
                    {heading(status)} (
                    {inventory.filter((a) => sourceStatus(a.status) === status).length})
                  </option>
                ))}
              </select>
            </div>
            {!coverage.complete && (
              <details className="rounded-md border p-3 text-sm text-muted-foreground">
                <summary className="cursor-pointer">
                  {inventory.length} accounts loaded · Some additional accounts may be unavailable
                </summary>
                <p className="mt-2">
                  You can save the accounts shown here. Each selected account is checked again
                  before linking.
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() => void load()}
                >
                  Refresh list
                </Button>
                <details className="mt-2">
                  <summary className="cursor-pointer">Technical details</summary>
                  <p className="mt-1 break-words">{coverage.warnings.join(" ")}</p>
                </details>
              </details>
            )}
            <p className="text-sm text-muted-foreground">
              Showing {rows.length} of {inventory.length} loaded accounts · {chosen.length} of 10
              selected
            </p>
            <div className="grid gap-3 lg:grid-cols-2">
              {rows.slice(page * 20, page * 20 + 20).map((a) => (
                <div key={a.id} className="min-w-0 rounded-lg border p-4 space-y-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      className="mt-1"
                      aria-label={`Select ${a.label}`}
                      checked={chosen.includes(a.id)}
                      disabled={state.busy || (!chosen.includes(a.id) && chosen.length >= 10)}
                      onCheckedChange={(v) =>
                        setChosen((current) =>
                          v === true ? [...current, a.id] : current.filter((id) => id !== a.id),
                        )
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium">{a.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.program ?? a.platform} · {a.createdAt.slice(0, 10)}
                      </p>
                    </div>
                    <Badge variant="secondary">{heading(a.status ?? "Unknown")}</Badge>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Balance</dt>
                      <dd className="break-words font-medium">
                        <MonetaryValue>
                          {cash(accountValue(a, "balance"), a.currency)}
                        </MonetaryValue>
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Effective balance</dt>
                      <dd className="break-words font-medium">
                        <MonetaryValue>
                          {cash(
                            accountValue(a, "effectiveBalance", "effective_balance", "equity"),
                            a.currency,
                          )}
                        </MonetaryValue>
                      </dd>
                    </div>
                  </dl>
                  {chosen.includes(a.id) && (
                    <label className="block space-y-1 text-sm">
                      <span>Link to journal account</span>
                      <select
                        aria-label={`Journal account for ${a.label}`}
                        className="w-full min-w-0 rounded-md border bg-background p-2"
                        value={links[a.id] ?? ""}
                        onChange={(e) =>
                          setLinks((current) => ({ ...current, [a.id]: e.target.value }))
                        }
                      >
                        <option value="">Create a new journal account</option>
                        {journal.data?.accounts
                          .filter((j) => j.currency === a.currency)
                          .map((j) => (
                            <option key={j.id} value={j.id}>
                              {j.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </div>
              ))}
              {!rows.length && (
                <p className="py-6 text-sm text-muted-foreground">
                  No accounts match these filters. Try another status or clear your search.
                </p>
              )}
            </div>
            {rows.length > 20 && (
              <div className="flex items-center justify-between gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm">
                  Page {page + 1} / {Math.max(1, Math.ceil(rows.length / 20))}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(page + 1) * 20 >= rows.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={auto} onCheckedChange={(v) => setAuto(v === true)} />
              Automatically refresh active accounts daily
            </label>
            <Button
              disabled={state.busy}
              onClick={() =>
                void state.run(async () => {
                  const saved = await postJson<{ selection: Selection[] }>("/api/the5ers", {
                    action: "select",
                    ids: chosen,
                    autoSync: auto,
                    linkJournalAccounts: true,
                    journalLinks: Object.fromEntries(
                      Object.entries(links).filter(([id, target]) => chosen.includes(id) && target),
                    ),
                  });
                  setLinks(
                    Object.fromEntries(
                      saved.selection
                        .filter((a) => a.journalAccountId)
                        .map((a) => [a.id, a.journalAccountId!]),
                    ),
                  );
                  onLinked?.();
                  window.dispatchEvent(new Event("journal-accounts-changed"));
                  state.setNotice("Links saved. Refreshing account history…");
                  let failed = 0,
                    skipped = 0;
                  for (const account of saved.selection) {
                    try {
                      const result = await postJson<{ snapshot: SourceSnapshot }>("/api/the5ers", {
                        action: "sync",
                        id: account.id,
                      });
                      skipped += result.snapshot.skippedPositions ?? 0;
                    } catch {
                      failed++;
                    }
                  }
                  state.refresh();
                  window.dispatchEvent(new Event("journal-data-changed"));
                  state.setNotice(
                    failed
                      ? `Links saved. ${failed} account histories could not refresh; retry from the account card.`
                      : skipped
                        ? `Links saved. ${skipped} positions need review before they can be included in analytics.`
                        : "Links saved and account history refreshed.",
                  );
                })
              }
            >
              {state.busy ? "Saving and refreshing…" : `Save links (${chosen.length})`}
            </Button>
            <div className="text-xs text-muted-foreground">
              Linked accounts appear in your journal filters and analytics.
              <details className="mt-2">
                <summary className="cursor-pointer">About balances</summary>
                <p className="mt-1">
                  These are balances reported by The5ers. Your journal’s initial capital stays
                  unchanged.
                </p>
              </details>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
/** Cached broker balances supplement journal accounts; source finance lists do not render here. */
function LinkedAccountBalances({
  state,
  query = "",
}: {
  state: ReturnType<typeof useSource>;
  query?: string;
}) {
  const selected = new URLSearchParams(query).get("accounts")?.split(",").filter(Boolean) ?? [];
  const snapshots = (state.data?.snapshots ?? []).filter((snapshot) => {
    const linkedId =
      state.data?.selection.find((a) => a.id === snapshot.account.id)?.journalAccountId ??
      `the5ers_${snapshot.account.id}`;
    return !selected.length || selected.includes(linkedId);
  });
  return (
    <div className="space-y-3">
      {snapshots.map((snapshot) => (
        <div key={snapshot.account.id} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Updated {formatSourceDate(snapshot.retrievedAt, state.data?.timeZone ?? "UTC")}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy}
            onClick={() =>
              void state.run(async () => {
                await postJson("/api/the5ers", { action: "sync", id: snapshot.account.id });
                state.refresh();
                window.dispatchEvent(new Event("journal-data-changed"));
              })
            }
          >
            Refresh account
          </Button>
          {snapshot.sections.balance?.available ? (
            <The5ersBalance
              value={snapshot.sections.balance.data}
              currency={snapshot.account.currency}
              showInitialBalance
            />
          ) : (
            <p className="text-sm text-muted-foreground">Balance unavailable.</p>
          )}
        </div>
      ))}
    </div>
  );
}
export function The5ersLinkedAccount({ accountId }: { accountId: string }) {
  const state = useSource();
  if (!state.data?.connected) return null;
  return <LinkedAccountBalances state={state} query={`accounts=${accountId}`} />;
}
