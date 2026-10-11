import { eq } from "drizzle-orm";
import { db, folders, notes } from "@/db";
import { bad, handler, ok } from "@/server/api";
import { nowIso } from "@/server/ids";

type Params = { params: Promise<{ id: string }> };

interface PatchNoteBody {
  title?: string;
  content?: string;
  tags?: string[];
  folderId?: string;
}

export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const [existing] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (!existing) return bad("Note not found", 404);
  const body = (await request.json()) as PatchNoteBody;
  if (body.folderId !== undefined) {
    const [folder] = await db.select().from(folders).where(eq(folders.id, body.folderId)).limit(1);
    if (!folder || folder.deletedAt || body.folderId === "all") return bad("Folder not found", 404);
  }
  await db
    .update(notes)
    .set({
      title: body.title ?? existing.title,
      content: body.content ?? existing.content,
      tagsJson: body.tags ? JSON.stringify(body.tags) : existing.tagsJson,
      folderId: body.folderId ?? existing.folderId,
      updatedAt: nowIso(),
    })
    .where(eq(notes.id, id));
  return ok({ updated: true });
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  await db.delete(notes).where(eq(notes.id, id));
  return ok({ deleted: true });
});
