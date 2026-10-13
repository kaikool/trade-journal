import { createClient } from "@supabase/supabase-js";
import { MAX_ATTACHMENT_SIZE } from "@/lib/attachment-validation";

export const ATTACHMENT_BUCKET = "journal-attachments";
const SIGNED_URL_SECONDS = 60;
const INSPECT_BYTES = 32;

type SupabaseStorageClient = ReturnType<typeof createClient>["storage"];

let storageClient: SupabaseStorageClient | null = null;

function client() {
  if (storageClient) return storageClient;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase Storage credentials are required");
  storageClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage;
  return storageClient;
}

function bucket() {
  return client().from(ATTACHMENT_BUCKET);
}

function requireStorage<T>(value: T | null, error: { message?: string } | null): T {
  if (error) throw new Error(error.message || "Supabase Storage request failed");
  if (!value) throw new Error("Supabase Storage returned an empty response");
  return value;
}

export async function createAttachmentUpload({ path, mime }: { path: string; mime: string }) {
  const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: false });
  const result = requireStorage(data, error);
  return { signedUrl: result.signedUrl, path: result.path, token: result.token, mime };
}

export async function createAttachmentDownload(path: string) {
  const { data, error } = await bucket().createSignedUrl(path, SIGNED_URL_SECONDS, {
    download: false,
  });
  return requireStorage(data, error).signedUrl;
}

export async function inspectAttachmentObject(path: string) {
  const signedUrl = await createAttachmentDownload(path);
  const signal = AbortSignal.timeout(10_000);
  const head = await fetch(signedUrl, { method: "HEAD", cache: "no-store", signal });
  if (!head.ok) throw new Error("Uploaded object not found");
  const size = Number(head.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_SIZE)
    throw new Error("Uploaded object size is invalid");
  const mime = head.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const bytes = await fetch(signedUrl, {
    headers: { range: `bytes=0-${INSPECT_BYTES - 1}` },
    cache: "no-store",
    signal,
  });
  if (bytes.status !== 206 || !bytes.body) {
    await bytes.body?.cancel();
    throw new Error("Storage must honor the inspection byte range");
  }
  const reader = bytes.body.getReader();
  const headBytes = new Uint8Array(INSPECT_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > INSPECT_BYTES)
        throw new Error("Storage exceeded the inspection byte range");
      headBytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
  return {
    path,
    size,
    mime,
    headBytes: headBytes.subarray(0, length),
  };
}

export async function removeAttachmentObject(path: string) {
  const { error } = await bucket().remove([path]);
  if (error) throw new Error(error.message || "Supabase Storage delete failed");
}

export async function uploadMarketDataset(path: string, json: string): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Configure Supabase Storage before importing market candles.");
  const { error } = await bucket().upload(path, Buffer.from(json, "utf8"), {
    contentType: "application/json",
    upsert: true,
  });
  if (error) throw new Error(error.message || "Supabase Storage market dataset upload failed");
}

export async function downloadMarketDataset(path: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  const { data, error } = await bucket().download(path);
  if (error || !data) return null;
  return await data.text();
}

export async function removeMarketDataset(path: string): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return;
  const { error } = await bucket().remove([path]);
  if (error) throw new Error(error.message || "Supabase Storage market dataset delete failed");
}
