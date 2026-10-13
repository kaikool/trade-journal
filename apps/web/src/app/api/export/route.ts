import {
  db,
  accounts,
  executions,
  journalDays,
  notes,
  playbooks,
  trades,
  attachments,
  noteTemplates,
  tradeRuleChecks,
  progressRules,
  progressChecks,
  missedTrades,
  folders,
  propAccounts,
  propEntries,
  propReceipts,
  propAudit,
  importSources,
  importSourceAliases,
  importBatches,
} from "@/db";
import { readFilters } from "@luxalgo/journal-core";
import { queryTrades } from "@/server/trades-query";
import {
  getJournalDefaults,
  getMultipliers,
  getTimeZone,
  getImportTimeZone,
} from "@/server/settings";
import { handler, ok } from "@/server/api";
import { attachmentExportRecord, EXPORT_ATTACHMENTS_NOTE } from "@/lib/export-format";
import { csvCell } from "@/lib/csv-export";

/**
 * Full data export: your journal is yours. Credentials are deliberately
 * excluded: an export must be safe to share or move between machines.
 */
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";

  if (format === "csv") {
    const header =
      "key,account_id,symbol,direction,status,opened_at,closed_at,quantity,avg_entry,avg_exit,gross_pnl,fees,net_pnl,tags,notes";
    const { rows } = await queryTrades(readFilters(url.searchParams));
    const lines = rows.map((row) =>
      [
        row.key,
        row.accountId,
        row.symbol,
        row.direction,
        row.status,
        row.openedAt,
        row.closedAt ?? "",
        row.quantity,
        row.avgEntry,
        row.avgExit ?? "",
        row.grossPnl,
        row.fees,
        row.netPnl,
        row.tagsJson ?? "[]",
        row.notes ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
    return new Response([header, ...lines].join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="trades.csv"',
      },
    });
  }

  const [
    accountsRows,
    executionsRows,
    importSourcesRows,
    importSourceAliasesRows,
    importBatchesRows,
    tradesRows,
    journalDaysRows,
    notesRows,
    foldersRows,
    playbooksRows,
    noteTemplatesRows,
    tradeRuleChecksRows,
    progressRulesRows,
    progressChecksRows,
    missedTradesRows,
    propAccountsRows,
    propEntriesRows,
    propReceiptsRows,
    propAuditRows,
    journalDefaults,
    timeZone,
    importTimeZone,
    multipliers,
    attachmentsRows,
  ] = await Promise.all([
    db.select().from(accounts),
    db.select().from(executions),
    db.select().from(importSources),
    db.select().from(importSourceAliases),
    db.select().from(importBatches),
    db.select().from(trades),
    db.select().from(journalDays),
    db.select().from(notes),
    db.select().from(folders),
    db.select().from(playbooks),
    db.select().from(noteTemplates),
    db.select().from(tradeRuleChecks),
    db.select().from(progressRules),
    db.select().from(progressChecks),
    db.select().from(missedTrades),
    db.select().from(propAccounts),
    db.select().from(propEntries),
    db.select().from(propReceipts),
    db.select().from(propAudit),
    getJournalDefaults(),
    getTimeZone(),
    getImportTimeZone(),
    getMultipliers(),
    db
      .select({
        id: attachments.id,
        ownerType: attachments.ownerType,
        ownerId: attachments.ownerId,
        name: attachments.name,
        mime: attachments.mime,
        size: attachments.size,
        createdAt: attachments.createdAt,
      })
      .from(attachments),
  ]);

  return ok({
    exportedAt: new Date().toISOString(),
    note: EXPORT_ATTACHMENTS_NOTE,
    accounts: accountsRows.map(({ credentialsEnc: _omitted, ...safe }) => safe),
    executions: executionsRows,
    importSources: importSourcesRows,
    importSourceAliases: importSourceAliasesRows,
    importBatches: importBatchesRows,
    trades: tradesRows,
    journalDays: journalDaysRows,
    notes: notesRows,
    folders: foldersRows,
    playbooks: playbooksRows,
    noteTemplates: noteTemplatesRows,
    tradeRuleChecks: tradeRuleChecksRows,
    progressRules: progressRulesRows,
    progressChecks: progressChecksRows,
    missedTrades: missedTradesRows,
    propAccounts: propAccountsRows,
    propEntries: propEntriesRows,
    propReceipts: propReceiptsRows,
    propAudit: propAuditRows,
    journalDefaults,
    settings: {
      timeZone,
      importTimeZone,
      multipliers,
    },
    // Metadata only: attachment binaries stay in storage.
    attachments: attachmentsRows.map(attachmentExportRecord),
  });
});
