"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { postJson } from "@/lib/use-api";

export function DailyAutoSyncToggle({
  accountId,
  enabled,
  onSaved,
}: {
  accountId: string;
  enabled: boolean;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox
        aria-label="Daily automatic broker sync"
        checked={enabled}
        disabled={saving}
        onCheckedChange={async (checked) => {
          const autoSync = checked === true;
          if (autoSync === enabled) return;
          setSaving(true);
          try {
            await postJson(`/api/accounts/${accountId}`, { autoSync }, "PATCH");
            onSaved();
          } catch (error) {
            alert(error instanceof Error ? error.message : "Could not update automatic sync.");
          } finally {
            setSaving(false);
          }
        }}
      />
      <span>
        <span className="block font-medium">Daily automatic sync</span>
        <span className="block text-xs text-muted-foreground">
          Vercel runs this once a day (UTC); you can also sync manually.
        </span>
      </span>
    </label>
  );
}
