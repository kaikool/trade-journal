import { eq } from "drizzle-orm";
import { db, folders, notes } from "@/db";
import { bad, handler, ok } from "@/server/api";
import { nowIso } from "@/server/ids";

type Params = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  return db.transaction(async (tx) => {
    const [folder] = await tx.select().from(folders).where(eq(folders.id, id)).limit(1);
    if (!folder || folder.deletedAt) return bad("Folder not found", 404);
    if (id === "all" || id === "my-notes") return bad("This folder cannot be deleted.");

    await tx.update(notes).set({ folderId: "my-notes" }).where(eq(notes.folderId, id));
    // Keep a tombstone so bootstrap cannot recreate a deleted built-in section.
    await tx.update(folders).set({ deletedAt: nowIso() }).where(eq(folders.id, id));
    return ok({ deleted: true });
  });
});
