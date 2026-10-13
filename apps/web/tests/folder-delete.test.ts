import { afterAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const { db, folders, notes } = await import("../src/db");
const { DELETE } = await import("../src/app/api/folders/[id]/route");
const { GET, POST } = await import("../src/app/api/notes/route");
const { PATCH } = await import("../src/app/api/notes/[id]/route");

const removeFolder = (id: string) =>
  DELETE(new Request(`http://localhost/api/folders/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
const createFolder = (id: string) =>
  db.insert(folders).values({ id, name: id, kind: "user", createdAt: "2026-01-01" });

it.each(["custom", "trade-notes", "daily-journal", "session-recaps"])(
  "removes %s while preserving all note fields and keeps it removed after bootstrap",
  async (id) => {
    if (id === "custom") await createFolder(id);
    const note = {
      id: `note-${id}`,
      folderId: id,
      title: "Keep this note",
      content: "Full content",
      tagsJson: '["review"]',
      tradeKey: "linked-trade",
      dayDate: "2026-10-05",
      createdAt: "2026-10-01",
      updatedAt: "2026-10-02",
    };
    await db.insert(notes).values(note);
    expect((await removeFolder(id)).status).toBe(200);
    const [saved] = await db.select().from(notes).where(eq(notes.id, note.id)).limit(1);
    expect(saved).toEqual({
      ...note,
      folderId: "my-notes",
    });
    const listed = await (await GET(new Request("http://localhost/api/notes"))).json();
    expect(listed.folders.some((folder: { id: string }) => folder.id === id)).toBe(false);
    expect((await removeFolder(id)).status).toBe(404);
  },
);

it.each(["all", "my-notes"])("keeps the essential %s view", async (id) => {
  expect((await removeFolder(id)).status).toBe(400);
  const [folder] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
  expect(folder?.deletedAt).toBeNull();
});

it("returns not found for a missing folder", async () => {
  expect((await removeFolder("missing")).status).toBe(404);
});

it("rolls back moving notes if folder removal fails", async () => {
  await createFolder("rollback");
  await db.insert(notes).values({
    id: "rollback-note",
    folderId: "rollback",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  await testDatabase.client.exec(`
    CREATE FUNCTION reject_folder_delete() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'Failed to remove folder'; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_folder_delete BEFORE UPDATE ON folders
    FOR EACH ROW WHEN (NEW.id = 'rollback') EXECUTE FUNCTION reject_folder_delete();
  `);
  try {
    expect((await removeFolder("rollback")).status).toBe(500);
    const [note] = await db.select().from(notes).where(eq(notes.id, "rollback-note")).limit(1);
    const [folder] = await db.select().from(folders).where(eq(folders.id, "rollback")).limit(1);
    expect(note?.folderId).toBe("rollback");
    expect(folder?.deletedAt).toBeNull();
  } finally {
    await testDatabase.client.exec(
      "DROP TRIGGER fail_folder_delete ON folders; DROP FUNCTION reject_folder_delete();",
    );
  }
});

it("rejects creating or moving notes into a removed folder", async () => {
  const response = await POST(
    new Request("http://localhost/api/notes", {
      method: "POST",
      body: JSON.stringify({ folderId: "trade-notes", title: "New note" }),
    }),
  );
  expect(response.status).toBe(404);
  const updated = await PATCH(
    new Request("http://localhost/api/notes/note-custom", {
      method: "PATCH",
      body: JSON.stringify({ folderId: "trade-notes" }),
    }),
    { params: Promise.resolve({ id: "note-custom" }) },
  );
  expect(updated.status).toBe(404);
  const [note] = await db.select().from(notes).where(eq(notes.id, "note-custom")).limit(1);
  expect(note?.folderId).toBe("my-notes");
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await testDatabase.close();
});

// Route fixtures authenticate with a real signed session.
vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
vi.mock("next/headers", async () => {
  const { sessionToken } = await import("../src/server/auth");
  return {
    cookies: async () => ({
      get: () => ({
        value: sessionToken(),
      }),
    }),
  };
});
