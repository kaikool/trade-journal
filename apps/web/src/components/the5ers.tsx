"use client";
import { useState } from "react";
import { RefreshCw, Link2, Unplug } from "lucide-react";
import { useApi, postJson } from "@/lib/use-api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { usePrivacy } from "./privacy";
import type { SourceAccount, Selection, SourceSnapshot } from "@/server/the5ers/data";

interface Overview {
  configured: boolean;
  connected: boolean;
  canRefresh: boolean;
  error?: string;
  selection: Selection[];
  snapshots: SourceSnapshot[];
}
const nameOf = (name: string) =>
  name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
/** Plain React text rendering. Source strings/links are never executable HTML or instructions. */
function SourceValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const privacy = usePrivacy();
  if (depth === 0 && privacy)
    return (
      <span aria-label="Source financial data hidden">
        Turn off privacy mode to view source data.
      </span>
    );
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">Unavailable</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value !== "object") return <span className="break-words">{String(value)}</span>;
  if (depth > 4)
    return <span className="text-muted-foreground">Additional nested source details</span>;
  if (Array.isArray(value))
    return value.length ? (
      <div className="space-y-3">
        {value.slice(0, 25).map((item, index) => (
          <div key={index} className="rounded-md border p-3">
            <SourceValue value={item} depth={depth + 1} />
          </div>
        ))}
        {value.length > 25 && (
          <p className="text-xs text-muted-foreground">
            Showing 25 of {value.length} source records.
          </p>
        )}
      </div>
    ) : (
      <span className="text-muted-foreground">No records returned</span>
    );
  return (
    <dl className="space-y-2">
      {Object.entries(value)
        .filter(([key]) => !["contract_version", "request_context"].includes(key))
        .map(([key, item]) => (
          <div key={key} className="grid gap-1 sm:grid-cols-[minmax(100px,1fr)_2fr]">
            <dt className="text-sm text-muted-foreground">{nameOf(key)}</dt>
            <dd className="min-w-0 text-sm">
              <SourceValue value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function The5ersConnection() {
  const state = useApi<Overview>("/api/the5ers");
  const [inventory, setInventory] = useState<SourceAccount[] | null>(null),
    [chosen, setChosen] = useState<string[]>([]),
    [autoSync, setAutoSync] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<{ title: string; data: unknown } | null>(null);
  const overview = state.data;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The5ers request failed.");
    } finally {
      setBusy(false);
    }
  };
  const load = () =>
    run(async () => {
      const result = await postJson<{ accounts: SourceAccount[] }>("/api/the5ers", {
        action: "accounts",
      });
      setInventory(result.accounts);
      setChosen(overview?.selection.map((item) => item.id) ?? []);
      setAutoSync(overview?.selection.some((item) => item.autoSync) ?? false);
    });
  const read = (resource: string, title: string, id?: string, positionKey?: string) =>
    run(async () => {
      const result = await postJson<{ data: unknown }>("/api/the5ers", {
        action: "read",
        resource,
        ...(id ? { id } : {}),
        ...(positionKey ? { positionKey } : {}),
      });
      setDetail({ title, data: result.data });
    });
  if (state.loading && !overview)
    return <p className="text-sm text-muted-foreground">Loading The5ers connection…</p>;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>The5ers connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Connect your The5ers Hub with read-only permissions. View your accounts and source
            records here, and refresh selected accounts on the journal&apos;s daily sync schedule.
          </p>
          {(state.error || error || overview?.error) && (
            <p role="alert" className="text-sm text-loss">
              {error ?? overview?.error ?? state.error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          {overview && !overview.configured && (
            <p className="text-sm text-muted-foreground">
              JOURNAL_SECRET is missing on this server. The5ers credentials cannot be stored
              securely.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || state.loading}
              onClick={() =>
                void run(async () => {
                  const { url } = await postJson<{ url: string }>("/api/the5ers", {
                    action: "connect",
                  });
                  window.location.assign(url);
                })
              }
            >
              <Link2 />
              {overview?.connected ? "Reconnect The5ers" : "Connect The5ers"}
            </Button>
            <Button
              variant="outline"
              disabled={busy || state.loading}
              onClick={() =>
                void run(async () => {
                  const result = await postJson<{ message: string }>("/api/the5ers", {
                    action: "check",
                  });
                  setNotice(result.message);
                })
              }
            >
              Check connection
            </Button>
            {overview?.connected && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void load()}>
                  <RefreshCw />
                  Load accounts
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await postJson("/api/the5ers", { action: "disconnect" });
                      setInventory(null);
                      setChosen([]);
                      setDetail(null);
                      state.refresh();
                    })
                  }
                >
                  <Unplug />
                  Disconnect
                </Button>
              </>
            )}
          </div>
          {overview?.connected && !overview.canRefresh && (
            <p className="text-sm text-muted-foreground">
              The5ers did not issue a refresh token. Scheduled reads may require reconnecting when
              access expires.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Automatic import into journal trade metrics awaits a verified execution format. Source
            P&amp;L is displayed as reported by The5ers, including its fee and swap treatment.
          </p>
        </CardContent>
      </Card>
      {inventory && (
        <Card>
          <CardHeader>
            <CardTitle>Select accounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Select up to 10 accounts. Contest accounts use a separate source and are not included
              in this selection.
            </p>
            {!inventory.length && <p>No trading accounts were returned.</p>}
            {inventory.map((account) => (
              <label key={account.id} className="flex items-start gap-3 rounded-md border p-3">
                <Checkbox
                  checked={chosen.includes(account.id)}
                  disabled={busy || (!chosen.includes(account.id) && chosen.length >= 10)}
                  onCheckedChange={(checked) =>
                    setChosen((current) =>
                      checked === true
                        ? [...current, account.id]
                        : current.filter((id) => id !== account.id),
                    )
                  }
                />
                <span>
                  <span className="block text-sm font-medium">{account.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {account.platform} · Created {account.createdAt}
                  </span>
                </span>
              </label>
            ))}
            <div className="flex items-center gap-2">
              <Checkbox
                id="the5ers-auto-sync"
                checked={autoSync}
                disabled={busy}
                onCheckedChange={(checked) => setAutoSync(checked === true)}
              />
              <Label htmlFor="the5ers-auto-sync">
                Refresh selected accounts automatically each day
              </Label>
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await postJson("/api/the5ers", { action: "select", ids: chosen, autoSync });
                  state.refresh();
                  setNotice("Account selection saved.");
                })
              }
            >
              Save account selection
            </Button>
          </CardContent>
        </Card>
      )}
      {overview?.selection.map((account) => {
        const snapshot = overview.snapshots.find((item) => item.account.id === account.id);
        const positionSection = snapshot?.sections.positions?.data as
          { rows?: { key: string; hasDetails: boolean; source: unknown }[] } | undefined;
        return (
          <Card key={account.id}>
            <CardHeader>
              <CardTitle>{account.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {account.autoSync ? "Daily refresh enabled" : "Manual refresh"}
                {snapshot ? ` · Retrieved ${snapshot.retrievedAt}` : " · Not refreshed yet"}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await postJson("/api/the5ers", { action: "sync", id: account.id });
                    state.refresh();
                    setNotice("The5ers source snapshot refreshed.");
                  })
                }
              >
                <RefreshCw />
                Refresh account
              </Button>
              {snapshot && !snapshot.complete && (
                <p role="status" className="text-sm text-muted-foreground">
                  This source snapshot is partial. Review section availability and coverage below.
                </p>
              )}
              {snapshot &&
                Object.entries(snapshot.sections)
                  .filter(([name]) => name !== "positions")
                  .map(([name, section]) => (
                    <details key={name} className="rounded-md border p-3">
                      <summary className="cursor-pointer text-sm font-medium">
                        {nameOf(name)}
                        {!section.available ? " · Unavailable" : ""}
                      </summary>
                      <div className="mt-3">
                        {section.available ? (
                          <SourceValue value={section.data} />
                        ) : (
                          <p className="text-sm text-muted-foreground">{section.error}</p>
                        )}
                      </div>
                    </details>
                  ))}
              {snapshot && (
                <details className="rounded-md border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Positions</summary>
                  <div className="mt-3 space-y-3">
                    {snapshot.sections.positions?.available ? (
                      positionSection?.rows?.slice(0, 25).map((position) => (
                        <div key={position.key} className="space-y-2 rounded-md border p-3">
                          <SourceValue value={position.source} />
                          {position.hasDetails && (
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  void read(
                                    "position",
                                    "Position details",
                                    account.id,
                                    position.key,
                                  )
                                }
                              >
                                Details
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  void read(
                                    "fills",
                                    "Position executions",
                                    account.id,
                                    position.key,
                                  )
                                }
                              >
                                Executions
                              </Button>
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {snapshot.sections.positions?.error ?? "Positions unavailable"}
                      </p>
                    )}
                    {(positionSection?.rows?.length ?? 0) > 25 && (
                      <p className="text-xs text-muted-foreground">
                        Showing the first 25 positions from this snapshot.
                      </p>
                    )}
                  </div>
                </details>
              )}
              <div className="flex flex-wrap gap-2">
                {[
                  ["health", "Account health"],
                  ["daily", "Daily summaries"],
                  ["balanceChart", "Balance history"],
                  ["journey", "Program journey"],
                  ["payoutHistory", "Payout history"],
                ].map(([resource, title]) => (
                  <Button
                    key={resource}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void read(resource!, title!, account.id)}
                  >
                    {title}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
      {overview?.connected && (
        <Card>
          <CardHeader>
            <CardTitle>Additional The5ers records</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Availability depends on the permissions granted and the records The5ers exposes.
              Payout, coupon and notification histories may be incomplete.
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                ["accountInventory", "Account source data"],
                ["purchases", "Account purchases"],
                ["wallet", "Credits"],
                ["coupons", "Coupons"],
                ["achievements", "Achievements"],
                ["alerts", "Notifications"],
                ["affiliate", "Affiliate"],
              ].map(([resource, title]) => (
                <Button
                  key={resource}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void read(resource!, title!)}
                >
                  {title}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      {detail && (
        <Card>
          <CardHeader>
            <CardTitle>{detail.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <SourceValue value={detail.data} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
