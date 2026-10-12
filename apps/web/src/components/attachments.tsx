"use client";
import { HoverHint } from "./ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ATTACHMENTS_CHANGED_EVENT, uploadAttachmentBlob } from "@/lib/chart-screenshot-upload";
import { postJson, useApi } from "@/lib/use-api";

export function Attachments({
  type,
  id,
}: {
  type: "trade" | "day" | "note" | "missed" | "prop-account" | "prop-entry";
  id: string;
}) {
  const { data, error, refresh } = useApi<{
    attachments: { id: string; name: string; mime: string; size: number }[];
  }>(`/api/attachments?type=${type}&id=${encodeURIComponent(id)}`);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const refreshIfChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; id: string }>).detail;
      if (detail?.type === type && detail.id === id) refresh();
    };
    window.addEventListener(ATTACHMENTS_CHANGED_EVENT, refreshIfChanged);
    return () => window.removeEventListener(ATTACHMENTS_CHANGED_EVENT, refreshIfChanged);
  }, [id, refresh, type]);
  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <Paperclip />
          {busy ? "Uploading…" : "Add attachment"}
        </Button>
        <span className="text-xs text-muted-foreground">Images or PDF · up to 8 MB each</span>
      </div>
      <input
        ref={input}
        aria-label="Upload attachment"
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="hidden"
        multiple
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          setBusy(true);
          setFailure("");
          try {
            for (const file of files) {
              await uploadAttachmentBlob(type, id, file.name, file);
            }
          } catch (err) {
            setFailure(err instanceof Error ? err.message : "Upload failed.");
          } finally {
            setBusy(false);
            if (input.current) input.current.value = "";
          }
        }}
      />
      {(failure || error) && (
        <p role="alert" className="text-xs text-destructive">
          {failure || error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {data?.attachments.map((a) => (
          <div key={a.id} className="min-w-0 rounded-md border p-2">
            <HoverHint content={a.name}>
              <a
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                {a.mime.startsWith("image/") && (
                  <img
                    src={`/api/attachments/${a.id}`}
                    alt={a.name}
                    className="mb-2 h-28 w-full rounded object-contain"
                  />
                )}
                <span className="block truncate text-xs underline">{a.name}</span>
              </a>
            </HoverHint>
            <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{Math.round(a.size / 1024)} KB</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Remove ${a.name}`}
                onClick={async () => {
                  if (!confirm(`Remove ${a.name}?`)) return;
                  try {
                    await postJson(`/api/attachments/${a.id}`, undefined, "DELETE");
                    refresh();
                  } catch (e) {
                    setFailure(String(e));
                  }
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
