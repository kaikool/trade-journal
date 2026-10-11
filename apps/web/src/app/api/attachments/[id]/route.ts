import { eq } from "drizzle-orm";
import { db, attachments } from "@/db";
import { handler, ok, bad } from "@/server/api";
import { createAttachmentDownload, removeAttachmentObject } from "@/server/storage";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Context) => {
  const { id } = await params;
  const [attachment] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!attachment || attachment.status !== "ready") return bad("Attachment not found", 404);
  const signedUrl = await createAttachmentDownload(attachment.storagePath);
  return new Response(null, {
    status: 302,
    headers: { Location: signedUrl, "Cache-Control": "private, no-store" },
  });
});

export const DELETE = handler(async (_request: Request, { params }: Context) => {
  const { id } = await params;
  const [attachment] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!attachment) return ok({ deleted: true });
  await removeAttachmentObject(attachment.storagePath);
  await db.delete(attachments).where(eq(attachments.id, id));
  return ok({ deleted: true });
});
