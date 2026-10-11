import { and, eq } from "drizzle-orm";
import { db, attachments, trades, notes, missedTrades, propAccounts, propEntries } from "@/db";
import { handler, ok, requireValue } from "@/server/api";
import { newId, nowIso } from "@/server/ids";
import {
  createAttachmentUpload,
  inspectAttachmentObject,
  removeAttachmentObject,
} from "@/server/storage";
import { attachmentMime, MAX_ATTACHMENT_SIZE } from "@/lib/attachment-validation";

const allowedDeclaredMime = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
const PENDING_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

async function owner(type: string, id: string) {
  if (type === "prop-account") {
    return !!(
      await db
        .select({ id: propAccounts.id })
        .from(propAccounts)
        .where(eq(propAccounts.id, id))
        .limit(1)
    )[0];
  }
  if (type === "prop-entry") {
    return !!(
      await db
        .select({ id: propEntries.id })
        .from(propEntries)
        .where(eq(propEntries.id, id))
        .limit(1)
    )[0];
  }
  if (type === "trade") {
    return !!(
      await db.select({ key: trades.key }).from(trades).where(eq(trades.key, id)).limit(1)
    )[0];
  }
  if (type === "note") {
    return !!(await db.select({ id: notes.id }).from(notes).where(eq(notes.id, id)).limit(1))[0];
  }
  if (type === "missed") {
    return !!(
      await db
        .select({ id: missedTrades.id })
        .from(missedTrades)
        .where(eq(missedTrades.id, id))
        .limit(1)
    )[0];
  }
  return (
    type === "day" &&
    /^\d{4}-\d{2}-\d{2}$/.test(id) &&
    !isNaN(Date.parse(id)) &&
    new Date(id).toISOString().slice(0, 10) === id
  );
}

function safeName(name: string) {
  const trimmed = name.trim().slice(0, 200);
  const basename = trimmed.split(/[\\/]/).pop() || "attachment";
  return (
    basename
      .replace(/[^\w. -]+/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 200) || "attachment"
  );
}

function storagePath(ownerType: string, ownerId: string, id: string, name: string) {
  return ["attachments", ownerType, encodeURIComponent(ownerId), id, encodeURIComponent(name)].join(
    "/",
  );
}

async function cleanupPendingAttachments(ownerType: string, ownerId: string) {
  const cutoff = Date.now() - PENDING_ATTACHMENT_TTL_MS;
  const pending = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.ownerType, ownerType),
        eq(attachments.ownerId, ownerId),
        eq(attachments.status, "pending"),
      ),
    );
  for (const attachment of pending) {
    if (Date.parse(attachment.createdAt) > cutoff) continue;
    await removeAttachmentObject(attachment.storagePath);
    await db.delete(attachments).where(eq(attachments.id, attachment.id));
  }
}

export const GET = handler(async (request: Request) => {
  const p = new URL(request.url).searchParams;
  const type = p.get("type") ?? "";
  const id = p.get("id") ?? "";
  requireValue(await owner(type, id), "Attachment owner not found.");
  return ok({
    attachments: await db
      .select({
        id: attachments.id,
        name: attachments.name,
        mime: attachments.mime,
        size: attachments.size,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.ownerType, type),
          eq(attachments.ownerId, id),
          eq(attachments.status, "ready"),
        ),
      ),
  });
});

async function prepareUpload(body: Record<string, unknown>) {
  const type = String(body.type ?? "");
  const ownerId = String(body.id ?? "");
  const name = safeName(String(body.name ?? ""));
  const size = Number(body.size ?? 0);
  const mime = String(body.mime ?? "");
  requireValue(await owner(type, ownerId), "Attachment owner not found.");
  requireValue(name.length > 0, "Attachment name is required.");
  requireValue(
    Number.isSafeInteger(size) && size > 0 && size <= MAX_ATTACHMENT_SIZE,
    "Choose a file up to 8 MB.",
  );
  requireValue(allowedDeclaredMime.has(mime), "Supported files: PNG, JPEG, WebP and PDF.");
  await cleanupPendingAttachments(type, ownerId);

  const id = newId();
  const path = storagePath(type, ownerId, id, name);
  const upload = await createAttachmentUpload({ path, mime });
  await db.insert(attachments).values({
    id,
    ownerType: type,
    ownerId,
    name,
    mime,
    size,
    storagePath: path,
    status: "pending",
    createdAt: nowIso(),
  });
  return ok({ id, uploadUrl: upload.signedUrl, path, token: upload.token });
}

async function finalizeUpload(body: Record<string, unknown>) {
  const id = String(body.id ?? "");
  const [attachment] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  requireValue(attachment, "Attachment not found.");
  if (attachment.status === "ready") {
    return ok({ id: attachment.id, mime: attachment.mime, size: attachment.size });
  }

  const object = await inspectAttachmentObject(attachment.storagePath);
  requireValue(object.path === attachment.storagePath, "Uploaded object path mismatch.");
  requireValue(object.size === attachment.size, "Uploaded file size changed.");
  requireValue(
    object.size > 0 && object.size <= MAX_ATTACHMENT_SIZE,
    "Files must be 8 MB or smaller.",
  );
  const magicMime = attachmentMime(object.headBytes);
  requireValue(magicMime, "Supported files: PNG, JPEG, WebP and PDF.");
  requireValue(
    magicMime === attachment.mime && object.mime === attachment.mime,
    "Uploaded file type changed.",
  );

  await db
    .update(attachments)
    .set({ mime: magicMime, status: "ready" })
    .where(eq(attachments.id, attachment.id));
  return ok({ id: attachment.id, mime: magicMime, size: attachment.size });
}

export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as Record<string, unknown>;
  if (body.action === "prepare") return prepareUpload(body);
  if (body.action === "finalize") return finalizeUpload(body);
  requireValue(false, "Unknown attachment action.");
});
