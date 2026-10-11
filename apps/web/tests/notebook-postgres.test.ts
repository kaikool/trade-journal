import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, folders, notes } = await import("../src/db");
const foldersRoute = await import("../src/app/api/folders/route");
const folderRoute = await import("../src/app/api/folders/[id]/route");
const notesRoute = await import("../src/app/api/notes/route");
const noteRoute = await import("../src/app/api/notes/[id]/route");

const jsonRequest = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  await db.delete(notes);
  await db.delete(folders);
  await db.insert(folders).values([
    { id: "all", name: "All notes", kind: "system", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "my-notes", name: "My notes", kind: "system", createdAt: "2026-01-01T00:00:01.000Z" },
  ]);
});

describe("Postgres notebook routes", () => {
  it("creates, filters, updates, and deletes notes asynchronously", async () => {
    const createFolder = await foldersRoute.POST(
      jsonRequest("http://test.local/api/folders", {
        name: " Setups ",
      }),
    );
    expect(createFolder.status).toBe(200);
    const { id: folderId } = (await createFolder.json()) as { id: string };

    const createNote = await notesRoute.POST(
      jsonRequest("http://test.local/api/notes", {
        folderId,
        title: "Breakout plan",
        content: "Wait for retest",
        tags: ["plan"],
      }),
    );
    expect(createNote.status).toBe(200);
    const { id: noteId } = (await createNote.json()) as { id: string };

    const list = await notesRoute.GET(
      new Request("http://test.local/api/notes?folder=all&q=breakout&tag=plan&sort=title"),
    );
    const payload = (await list.json()) as { notes: Array<{ id: string }>; folders: unknown[] };
    expect(payload.notes.map((note) => note.id)).toEqual([noteId]);
    expect(payload.folders).toHaveLength(3);

    const patch = await noteRoute.PATCH(
      new Request("http://test.local/api/notes/" + noteId, {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated", folderId: "my-notes" }),
      }),
      { params: Promise.resolve({ id: noteId }) },
    );
    expect(patch.status).toBe(200);
    expect((await db.select().from(notes).where(eq(notes.id, noteId)).limit(1))[0]).toMatchObject({
      title: "Updated",
      content: "Wait for retest",
      folderId: "my-notes",
    });

    const remove = await noteRoute.DELETE(new Request("http://test.local/api/notes/" + noteId), {
      params: Promise.resolve({ id: noteId }),
    });
    expect(remove.status).toBe(200);
    expect(await db.select().from(notes)).toHaveLength(0);
  });

  it("soft-deletes folders while preserving notes in my-notes", async () => {
    await db.insert(folders).values({
      id: "folder-a",
      name: "Archive",
      kind: "user",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await db.insert(notes).values({
      id: "note-a",
      folderId: "folder-a",
      title: "Preserved",
      content: "Keep me",
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    });

    const response = await folderRoute.DELETE(
      new Request("http://test.local/api/folders/folder-a"),
      {
        params: Promise.resolve({ id: "folder-a" }),
      },
    );
    expect(response.status).toBe(200);

    const [folder] = await db.select().from(folders).where(eq(folders.id, "folder-a")).limit(1);
    const [note] = await db.select().from(notes).where(eq(notes.id, "note-a")).limit(1);
    expect(folder?.deletedAt).toBeTruthy();
    expect(note?.folderId).toBe("my-notes");
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
