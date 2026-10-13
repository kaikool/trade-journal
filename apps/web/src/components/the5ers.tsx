"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sourceStatus, defaultSourceVisible } from "@/lib/the5ers-status";
import { useApi, postJson } from "@/lib/use-api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { MonetaryValue, usePrivacy } from "./privacy";
import type { SourceAccount, Selection, SourceSnapshot } from "@/server/the5ers/data";
interface Overview {
  configured: boolean;
  connected: boolean;
  canRefresh: boolean;
  error?: string;
  selection: Selection[];
  snapshots: SourceSnapshot[];
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
function useSource() {
  const state = useApi<Overview>("/api/the5ers");
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
  const state = useSource(),
    overview = state.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>The5ers connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Read-only Hub connection. Manage linked accounts in Accounts and program finances in Prop
          firms.
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
            <p className="text-sm">
              Connected · {overview.selection.length} selected accounts
              {!overview.canRefresh ? " · Reconnect required when access expires" : ""}
            </p>
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
        <Messages state={state} />
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
                placeholder="Search account or platform"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                className="max-w-sm"
              />
              <select
                aria-label="Filter The5ers account status"
                className="rounded-md border bg-background p-2 text-sm"
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
              <p role="alert" className="text-sm text-destructive">
                Account list incomplete. {coverage.warnings.join(" ")} Linking is disabled until
                coverage is confirmed.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {rows.length} matching / {inventory.length} accounts · {chosen.length} selected
              (maximum 10)
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2">Select</th>
                    <th className="p-2">Account</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Journal link</th>
                    <th className="p-2">Balance</th>
                    <th className="p-2">Effective balance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(page * 20, page * 20 + 20).map((a) => (
                    <tr key={a.id} className="border-b">
                      <td className="p-2">
                        <Checkbox
                          aria-label={`Select ${a.label}`}
                          checked={chosen.includes(a.id)}
                          disabled={state.busy || (!chosen.includes(a.id) && chosen.length >= 10)}
                          onCheckedChange={(v) =>
                            setChosen((current) =>
                              v === true ? [...current, a.id] : current.filter((id) => id !== a.id),
                            )
                          }
                        />
                      </td>
                      <td className="p-2">
                        <div>{a.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {a.platform} · {a.program ?? "Program unavailable"} ·{" "}
                          {a.createdAt.slice(0, 10)}
                        </div>
                      </td>
                      <td className="p-2">{a.status ?? "Unavailable"}</td>
                      <td className="p-2">
                        <select
                          aria-label={`Journal account for ${a.label}`}
                          className="max-w-40 rounded-md border bg-background p-2"
                          value={links[a.id] ?? ""}
                          onChange={(e) =>
                            setLinks((current) => ({ ...current, [a.id]: e.target.value }))
                          }
                        >
                          <option value="">Create account</option>
                          {journal.data?.accounts
                            .filter((j) => j.currency === a.currency)
                            .map((j) => (
                              <option key={j.id} value={j.id}>
                                {j.name}
                              </option>
                            ))}
                        </select>
                      </td>
                      <td className="p-2">
                        <MonetaryValue>
                          {cash(accountValue(a, "balance"), a.currency)}
                        </MonetaryValue>
                      </td>
                      <td className="p-2">
                        <MonetaryValue>
                          {cash(
                            accountValue(a, "effectiveBalance", "effective_balance", "equity"),
                            a.currency,
                          )}
                        </MonetaryValue>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-3">
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
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={auto} onCheckedChange={(v) => setAuto(v === true)} />
              Daily source refresh for active accounts only
            </label>
            <Button
              disabled={state.busy || !coverage.complete}
              onClick={() =>
                void state.run(async () => {
                  await postJson("/api/the5ers", {
                    action: "select",
                    ids: chosen,
                    autoSync: auto,
                    linkJournalAccounts: true,
                    journalLinks: Object.fromEntries(
                      Object.entries(links).filter(([id, target]) => chosen.includes(id) && target),
                    ),
                  });
                  state.refresh();
                  onLinked?.();
                  window.dispatchEvent(new Event("journal-accounts-changed"));
                  state.setNotice(
                    "Selected accounts linked to journal filters. Existing records were preserved.",
                  );
                })
              }
            >
              Save and link selected accounts
            </Button>
            <p className="text-xs text-muted-foreground">
              Current balances do not set initial capital. Linking makes accounts available to
              journal filters; source executions are not yet imported into trade analytics.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
function SnapshotPanels({
  view,
  state,
  section = "overview",
  query = "",
}: {
  view: "accounts" | "prop" | "trades" | "dashboard";
  state: ReturnType<typeof useSource>;
  section?: string;
  query?: string;
}) {
  const [detail, setDetail] = useState<{ title: string; data: unknown } | null>(null);
  useEffect(() => setDetail(null), [view, section, query]);
  const params = new URLSearchParams(query);
  const selected = params.get("accounts")?.split(",").filter(Boolean) ?? [];
  const snapshots = (state.data?.snapshots ?? []).filter(
    (s) =>
      !selected.length ||
      selected.includes(
        state.data?.selection.find((a) => a.id === s.account.id)?.journalAccountId ??
          `the5ers_${s.account.id}`,
      ),
  );
  const read = (resource: string, title: string, id?: string, key?: string) =>
    state.run(async () => {
      const result = await postJson<{ data: unknown }>("/api/the5ers", {
        action: "read",
        resource,
        ...(id ? { id } : {}),
        ...(key ? { positionKey: key } : {}),
      });
      setDetail({ title, data: result.data });
    });
  return (
    <div className="space-y-3">
      {(view === "prop" && ["ledger", "benefits", "activity"].includes(section)
        ? []
        : (state.data?.selection ?? [])
      )
        .filter(
          (a) => !selected.length || selected.includes(a.journalAccountId ?? `the5ers_${a.id}`),
        )
        .map((a) => {
          const snapshot = snapshots.find((s) => s.account.id === a.id);
          const account = snapshot?.account;
          const sections = snapshot?.sections ?? {};
          const visible =
            view === "accounts" || view === "dashboard"
              ? ["balance"]
              : view === "prop"
                ? section === "payouts"
                  ? ["payout"]
                  : section === "ledger"
                    ? []
                    : ["rules", "consistency", "performance"]
                : [];
          const positions = obj(sections.positions?.data).rows as
            { key: string; hasDetails: boolean; source: unknown }[] | undefined;
          return (
            <Card key={a.id}>
              <CardHeader>
                <CardTitle>{a.label}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {snapshot ? `Source retrieved ${snapshot.retrievedAt}` : "Not refreshed yet"} ·{" "}
                  {a.autoSync ? "Daily refresh" : "Manual refresh"}
                </p>
                {view !== "dashboard" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(async () => {
                        await postJson("/api/the5ers", { action: "sync", id: a.id });
                        state.refresh();
                      })
                    }
                  >
                    Refresh source
                  </Button>
                )}
                {snapshot && !snapshot.complete && (
                  <p className="text-xs text-muted-foreground">
                    This source snapshot is partial. Some sections or history may be unavailable.
                  </p>
                )}
                {visible.map(
                  (name) =>
                    sections[name] && (
                      <div key={name} className="rounded-md border p-3">
                        <h4 className="mb-2 text-sm font-medium">
                          {heading(name)} (
                          {String(
                            obj(sections[name].data).currency ??
                              account?.currency ??
                              "currency unavailable",
                          )}
                          )
                        </h4>
                        {sections[name].available ? (
                          <SourceValue value={sections[name].data} />
                        ) : (
                          <p className="text-sm">{sections[name].error}</p>
                        )}
                      </div>
                    ),
                )}
                {view === "trades" && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Provider positions and executions. These records have not been included in
                      journal trading metrics.
                    </p>
                    {positions?.slice(0, 100).map((p) => (
                      <div key={p.key} className="space-y-2 rounded-md border p-3">
                        <SourceValue value={p.source} />
                        {p.hasDetails && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={state.busy}
                              onClick={() => void read("position", "Position details", a.id, p.key)}
                            >
                              Details
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={state.busy}
                              onClick={() => void read("fills", "Position executions", a.id, p.key)}
                            >
                              Executions
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                    {!sections.positions?.available && (
                      <p className="text-sm">
                        {sections.positions?.error ?? "Refresh this account to retrieve positions."}
                      </p>
                    )}
                    {(positions?.length ?? 0) > 100 && (
                      <p className="text-xs">
                        Showing 100 of {positions?.length} source positions.
                      </p>
                    )}
                  </>
                )}
                {view === "prop" && section !== "ledger" && (
                  <div className="flex flex-wrap gap-2">
                    {(section === "payouts"
                      ? [["payoutHistory", "Payout history"]]
                      : [
                          ["health", "Account health"],
                          ["journey", "Program journey"],
                        ]
                    ).map(([resource, title]) => (
                      <Button
                        key={resource}
                        size="sm"
                        variant="outline"
                        disabled={state.busy}
                        onClick={() => void read(resource!, title!, a.id)}
                      >
                        {title}
                      </Button>
                    ))}
                  </div>
                )}
                {view === "accounts" && account && (
                  <p className="text-xs text-muted-foreground">
                    Source status:{" "}
                    {account.status ?? String(accountValue(account, "status") ?? "Unavailable")} ·
                    Starting capital is maintained independently.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      {view === "prop" && state.data?.connected && (
        <div className="flex flex-wrap gap-2">
          {(section === "ledger"
            ? [["purchases", "Purchases & fees"]]
            : section === "benefits"
              ? [
                  ["wallet", "Credits"],
                  ["coupons", "Coupons"],
                  ["achievements", "Achievements"],
                ]
              : section === "activity"
                ? [
                    ["alerts", "Notifications"],
                    ["affiliate", "Affiliate"],
                  ]
                : []
          ).map(([resource, title]) => (
            <Button
              key={resource}
              variant="outline"
              disabled={state.busy}
              onClick={() => void read(resource!, title!)}
            >
              {title}
            </Button>
          ))}
        </div>
      )}
      {view === "prop" &&
        selected.length > 0 &&
        ["ledger", "benefits", "activity"].includes(section) && (
          <p className="text-xs text-muted-foreground">
            Hub-wide records cannot yet be attributed safely to this account. Clear the account
            filter to view them.
          </p>
        )}
      {detail && (
        <Card>
          <CardHeader>
            <CardTitle>
              {detail.title}{" "}
              <span className="text-xs font-normal text-muted-foreground">· Provider records</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {view === "prop" && (section === "ledger" || section === "payouts") && (
              <p className="text-xs text-muted-foreground">
                Source records awaiting reconciliation. They do not count as posted spending or
                received cash in the totals above.
              </p>
            )}
            {obj(detail.data).complete === false && (
              <p className="text-xs">Source history is partial.</p>
            )}
            <SourceValue value={detail.data} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
export function The5ersSource({
  view,
  section,
  query = "",
}: {
  view: "prop" | "trades" | "dashboard";
  section?: string;
  query?: string;
}) {
  const state = useSource();
  if (!state.data?.connected && !state.error) return null;
  if (view === "dashboard" && !state.data?.snapshots.length) return null;
  return (
    <section className="space-y-3 p-4" aria-label="The5ers source records">
      <h2 className="text-base font-semibold">
        {view === "trades"
          ? "Connected account positions"
          : view === "dashboard"
            ? "Connected account balances"
            : "The5ers program records"}
      </h2>
      <Messages state={state} />
      <SnapshotPanels view={view} section={section} state={state} query={query} />
    </section>
  );
}

export function The5ersLinkedAccount({ accountId }: { accountId: string }) {
  const state = useSource();
  if (!state.data?.connected) return null;
  return <SnapshotPanels view="accounts" state={state} query={`accounts=${accountId}`} />;
}
