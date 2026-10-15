"use client";

import { Suspense, useState, useMemo } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckSquare,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { The5ersLinkedAccount } from "@/components/the5ers";
import { AccountCreateForm } from "@/components/account-create-form";
import { FilterBar } from "@/components/filter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { postJson, useApi } from "@/lib/use-api";
import { fmtMoney } from "@/lib/utils";
import { MonetaryValue, MonetaryField } from "@/components/privacy";
import { DailyAutoSyncToggle } from "@/components/daily-auto-sync-toggle";
import { isEnabledSyncBroker } from "@/lib/supported-brokers";

interface AccountRow {
  id: string;
  the5ersSourceId?: string;
  name: string;
  the5ersSelected?: boolean;
  visibleInJournal?: boolean;
  propStatus?: string;
  propProgram?: string;
  propSizeMinor?: number;
  isActive?: boolean;
  broker: string;
  kind: "sync" | "import" | "manual";
  currency: string;
  initialBalance: number;
  profitCalcMethod: "fifo" | "lifo" | "wavg";
  autoSync: boolean;
  lastSyncAt: string | null;
  archivedAt: string | null;
  connected: boolean;
  snapshot: { equity: number; positions: unknown[] } | null;
}

export default function AccountsPage() {
  return (
    <Suspense>
      <Accounts />
    </Suspense>
  );
}

function Accounts() {
  const { data, refresh } = useApi<{ accounts: AccountRow[] }>("/api/accounts");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [updatingBulk, setUpdatingBulk] = useState(false);
  const [search, setSearch] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "visible" | "active">("all");

  const accounts = data?.accounts ?? [];

  const visibleCount = useMemo(() => accounts.filter((a) => a.visibleInJournal).length, [accounts]);
  const activeCount = useMemo(() => accounts.filter((a) => a.isActive).length, [accounts]);

  const filteredAccounts = useMemo(() => {
    return accounts.filter((account) => {
      if (filterTab === "visible" && !account.visibleInJournal) return false;
      if (filterTab === "active" && !account.isActive) return false;
      if (search.trim()) {
        const query = search.toLowerCase();
        return (
          account.name.toLowerCase().includes(query) ||
          account.broker.toLowerCase().includes(query) ||
          account.id.toLowerCase().includes(query) ||
          (account.propProgram && account.propProgram.toLowerCase().includes(query))
        );
      }
      return true;
    });
  }, [accounts, filterTab, search]);

  const handleBulkVisibility = async (action: "select-all" | "select-active" | "deselect-all") => {
    setUpdatingBulk(true);
    try {
      await postJson("/api/accounts", { action }, "PUT");
      refresh();
      window.dispatchEvent(new Event("journal-data-changed"));
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to update account visibility");
    } finally {
      setUpdatingBulk(false);
    }
  };

  const action = async <T = unknown,>(id: string, body: Record<string, unknown>) => {
    const result = await postJson<T>(`/api/accounts/${id}/actions`, body);
    refresh();
    return result;
  };

  const sync = async (id: string) => {
    setSyncing(id);
    try {
      const { sync: outcome } = await action<{
        sync: { inserted: number; skipped: number; skippedReasons: string[] };
      }>(id, { action: "sync" });
      window.dispatchEvent(new Event("journal-data-changed"));
      if (outcome.skipped > 0)
        alert(
          `Sync finished with ${outcome.inserted} new fills. ${outcome.skipped} broker record(s) were skipped: ${outcome.skippedReasons.join(" ")}`,
        );
    } catch (error) {
      alert(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setSyncing(null);
    }
  };

  return (
    <div>
      <FilterBar
        title="Accounts"
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New account
          </Button>
        }
      />
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New account</DialogTitle>
            <DialogDescription>
              Create an account for manual trades or file imports.
            </DialogDescription>
          </DialogHeader>
          <AccountCreateForm
            showTitle={false}
            onCreated={() => {
              refresh();
              setCreating(false);
            }}
          />
        </DialogContent>
      </Dialog>

      <div className="border-b bg-card/60 px-4 py-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              Dashboard & Trades account visibility
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Total: {accounts.length} accounts · Displayed: {visibleCount} · Active: {activeCount}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={updatingBulk || accounts.length === 0}
              onClick={() => void handleBulkVisibility("select-all")}
              title="Select all accounts to display in Dashboard & Trades"
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1" />
              Select all
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={updatingBulk || accounts.length === 0}
              onClick={() => void handleBulkVisibility("select-active")}
              title="Select only active accounts"
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              Active only
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={updatingBulk || accounts.length === 0}
              onClick={() => void handleBulkVisibility("deselect-all")}
              title="Deselect all accounts"
            >
              <Square className="h-3.5 w-3.5 mr-1" />
              Deselect all
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pt-2 border-t border-border/50">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={filterTab === "all" ? "secondary" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setFilterTab("all")}
            >
              All ({accounts.length})
            </Button>
            <Button
              size="sm"
              variant={filterTab === "visible" ? "secondary" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setFilterTab("visible")}
            >
              Displayed ({visibleCount})
            </Button>
            <Button
              size="sm"
              variant={filterTab === "active" ? "secondary" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setFilterTab("active")}
            >
              Active ({activeCount})
            </Button>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7.5 pl-8 text-xs"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2">
        {filteredAccounts.length === 0 && (
          <p className="col-span-full py-16 text-center text-sm text-muted-foreground">
            {accounts.length === 0
              ? "No accounts yet — connect The5ers in Settings or create a new account."
              : "No accounts match the current filter."}
          </p>
        )}
        {filteredAccounts.map((account) => (
          <Card key={account.id} className={account.archivedAt ? "opacity-60" : undefined}>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="min-w-0 flex-1 text-base font-semibold normal-case tracking-normal text-foreground">
                <span className="block break-words">
                  <MonetaryValue>{account.name}</MonetaryValue>
                </span>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {account.isActive ? (
                    <Badge className="bg-emerald-600 text-white hover:bg-emerald-700 text-xs py-0">
                      Active
                    </Badge>
                  ) : account.propStatus ? (
                    <Badge variant="outline" className="text-xs py-0">
                      {account.propStatus.toUpperCase()}
                    </Badge>
                  ) : account.archivedAt ? (
                    <Badge variant="secondary" className="text-xs py-0">
                      Archived
                    </Badge>
                  ) : null}
                  <Badge variant="secondary" className="text-xs py-0">
                    {account.the5ersSourceId ? "Synced" : account.kind}
                  </Badge>
                  {account.the5ersSourceId && (
                    <Badge variant="outline" className="text-xs py-0">
                      The5ers
                    </Badge>
                  )}
                  {account.propProgram && (
                    <Badge variant="outline" className="text-xs py-0">
                      {account.propProgram}
                    </Badge>
                  )}
                  {account.broker && account.broker !== "The5ers" && (
                    <span className="text-xs font-normal text-muted-foreground">
                      {account.broker}
                    </span>
                  )}
                </div>
              </CardTitle>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {account.kind === "sync" && isEnabledSyncBroker(account.broker) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={syncing === account.id}
                    onClick={() => void sync(account.id)}
                    title="Sync now"
                  >
                    <RefreshCw className={syncing === account.id ? "animate-spin" : undefined} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={account.archivedAt ? "Unarchive" : "Archive"}
                  onClick={() =>
                    void action(account.id, {
                      action: account.archivedAt ? "unarchive" : "archive",
                    })
                  }
                >
                  {account.archivedAt ? <ArchiveRestore /> : <Archive />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  title="Delete account"
                  onClick={async () => {
                    if (
                      confirm(`Delete "${account.name}" and ALL its trades? This cannot be undone.`)
                    ) {
                      await postJson(`/api/accounts/${account.id}`, undefined, "DELETE");
                      refresh();
                    }
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-2.5">
                <label
                  htmlFor={`toggle-${account.id}`}
                  className="flex items-center gap-2.5 cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    id={`toggle-${account.id}`}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer accent-primary"
                    checked={account.visibleInJournal ?? true}
                    onChange={async (e) => {
                      await postJson(`/api/accounts/${account.id}/actions`, {
                        action: "set-visibility",
                        visible: e.target.checked,
                      });
                      refresh();
                      window.dispatchEvent(new Event("journal-data-changed"));
                    }}
                  />
                  <span className="text-xs font-medium sm:text-sm">Show in Dashboard & Trades</span>
                </label>
                {account.visibleInJournal ? (
                  <Badge
                    variant="outline"
                    className="text-xs border-emerald-500/40 text-emerald-500 bg-emerald-500/10"
                  >
                    Displayed
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    Hidden
                  </Badge>
                )}
              </div>
              {account.the5ersSourceId && <The5ersLinkedAccount accountId={account.id} />}
              {account.snapshot && (
                <div className="text-sm">
                  Broker equity:{" "}
                  <span className="tnum font-medium">
                    <MonetaryValue>{fmtMoney(account.snapshot.equity)}</MonetaryValue>
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {account.snapshot.positions.length} open positions · synced{" "}
                    {account.lastSyncAt?.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
              )}
              {account.kind === "sync" &&
                isEnabledSyncBroker(account.broker) &&
                !account.archivedAt && (
                  <DailyAutoSyncToggle
                    accountId={account.id}
                    enabled={account.autoSync}
                    onSaved={refresh}
                  />
                )}
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm">Account settings</summary>
                <div className="mt-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <label className="mb-1 block text-xs text-muted-foreground">Account name</label>
                    <MonetaryField>
                      <Input
                        aria-label="Account name"
                        defaultValue={account.name}
                        onBlur={async (event) => {
                          const name = event.target.value.trim();
                          if (name && name !== account.name) {
                            await postJson(`/api/accounts/${account.id}`, { name }, "PATCH");
                            refresh();
                            window.dispatchEvent(new Event("journal-data-changed"));
                          }
                        }}
                      />
                    </MonetaryField>
                    {account.the5ersSourceId && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        The5ers only shares the last digits. Enter your full account number in this
                        name.
                      </p>
                    )}
                  </div>
                  <div className="min-w-0">
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Journal starting capital
                    </label>
                    <MonetaryField>
                      <Input
                        defaultValue={account.initialBalance || ""}
                        placeholder="0"
                        inputMode="decimal"
                        onBlur={async (event) => {
                          const value = Number(event.target.value || 0);
                          if (value !== account.initialBalance) {
                            await postJson(
                              `/api/accounts/${account.id}`,
                              { initialBalance: value },
                              "PATCH",
                            );
                            refresh();
                            window.dispatchEvent(new Event("journal-data-changed"));
                          }
                        }}
                      />
                    </MonetaryField>
                  </div>
                  {!account.the5ersSourceId && (
                    <div className="min-w-0">
                      <label className="mb-1 block text-xs text-muted-foreground">
                        Profit calculation
                      </label>
                      <Select
                        value={account.profitCalcMethod}
                        onValueChange={async (value) => {
                          await postJson(
                            `/api/accounts/${account.id}`,
                            { profitCalcMethod: value },
                            "PATCH",
                          );
                          refresh();
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fifo">FIFO</SelectItem>
                          <SelectItem value="lifo">LIFO</SelectItem>
                          <SelectItem value="wavg">Weighted average</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      if (confirm(`Clear ALL trades from "${account.name}"? The account stays.`)) {
                        await action(account.id, { action: "clear" });
                      }
                    }}
                  >
                    Clear trades
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const others = (data?.accounts ?? []).filter(
                        (candidate) => candidate.id !== account.id,
                      );
                      if (others.length === 0) return alert("No other account to transfer into.");
                      const target = prompt(
                        `Transfer all data into which account?\n${others.map((candidate, index) => `${index + 1}. ${candidate.name}`).join("\n")}\n\nEnter a number:`,
                      );
                      const chosen = others[Number(target) - 1];
                      if (chosen) {
                        try {
                          await action(account.id, {
                            action: "transfer",
                            toAccountId: chosen.id,
                          });
                        } catch (error) {
                          alert(error instanceof Error ? error.message : "Transfer failed");
                        }
                      }
                    }}
                  >
                    Transfer data
                  </Button>
                </div>
              </details>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
